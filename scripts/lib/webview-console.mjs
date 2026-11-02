// Records what the app's WebView prints (console, uncaught errors, browser log entries) on an Android device or emulator, through the
// Chrome DevTools protocol, so a failed golden flow comes with the page's own words and not only the picture of its last screen.
// logcat has no WebView console lines in this build (a CI run had none), which is why this exists.
//
//   node scripts/lib/webview-console.mjs collect <output file> [seconds, default 0 = until stopped]
//       keeps looking for the app's DevTools socket (it changes with every start of the app), connects, and appends one JSON line per
//       event to the file; reconnects when the app restarts. Stop it with SIGTERM or SIGINT; it writes a last line and exits 0.
//   node scripts/lib/webview-console.mjs snapshot <output file>
//       one shot: writes what the page shows now (title, address, the visible text) and exits 0, or 1 when no page can be reached.
//
// Needs `adb` on PATH and the app to be a debuggable build (the CI APKs are). Nothing here changes the device or the app.
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The names of the abstract sockets the WebViews of the device listen on, from the text of /proc/net/unix.
 * @param {string} text
 * @returns {string[]}
 */
export function devtoolsSockets(text) {
  const names = new Set();
  for (const match of text.matchAll(/@(webview_devtools_remote_\d+)/g)) names.add(/** @type {string} */ (match[1]));
  return [...names];
}

/** An address without its query and fragment: a sign-in code or a token may ride on them, and the record is kept as an artifact. */
export function withoutQuery(url) {
  return String(url ?? '').replace(/[?#].*$/s, '');
}

/**
 * One line of the record for a DevTools protocol event, or null for an event that is not kept.
 * @param {{ method?: string, params?: any }} message
 * @param {number} at milliseconds since the epoch
 * @returns {{ at: string, kind: string, level: string, text: string } | null}
 */
export function describeEvent(message, at) {
  const stamp = new Date(at).toISOString();
  const params = message.params ?? {};
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? []).map((/** @type {any} */ arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type ?? ''))).join(' ');
    return { at: stamp, kind: 'console', level: String(params.type ?? 'log'), text };
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails ?? {};
    const text = details.exception?.description ?? details.text ?? 'exception';
    return { at: stamp, kind: 'exception', level: 'error', text: `${String(text)} (${withoutQuery(details.url)}:${String(details.lineNumber ?? '')})` };
  }
  if (message.method === 'Log.entryAdded') {
    const entry = params.entry ?? {};
    return { at: stamp, kind: 'log', level: String(entry.level ?? 'info'), text: `${String(entry.text ?? '')} ${withoutQuery(entry.url)}`.trim() };
  }
  return null;
}

async function adb(...args) {
  // WEBVIEW_CONSOLE_ADB: a script run with node in place of adb (the tests use it; nothing else sets it).
  const fake = process.env.WEBVIEW_CONSOLE_ADB;
  const { stdout } = fake === undefined ? await run('adb', args, { timeout: 15000 }) : await run(process.execPath, [fake, ...args], { timeout: 15000 });
  return stdout;
}

const APP_ID = 'io.inspectorhub.app';
/** socket name -> local port: one forward per socket, not one per attempt. */
const forwards = new Map();

/** The WebView socket of the app (by its process id); another debuggable WebView on the device is not taken for it. */
async function appSocket() {
  const sockets = devtoolsSockets(await adb('shell', 'cat', '/proc/net/unix').catch(() => ''));
  const pids = (await adb('shell', 'pidof', APP_ID).catch(() => '')).trim().split(/\s+/).filter(Boolean);
  return sockets.find((name) => pids.some((pid) => name === `webview_devtools_remote_${pid}`)) ?? null;
}

/** Forwards a local port to the app's WebView socket and returns [name, port], or null when the app has none. */
async function forwardedPort() {
  const name = await appSocket();
  if (name === null) return null;
  const known = forwards.get(name);
  if (known !== undefined) return [name, known];
  const port = (await adb('forward', 'tcp:0', `localabstract:${name}`)).trim();
  if (!/^\d+$/.test(port)) return null;
  forwards.set(name, Number(port));
  return [name, Number(port)];
}

async function dropForward(name) {
  const port = forwards.get(name);
  forwards.delete(name);
  if (port !== undefined) await adb('forward', '--remove', `tcp:${String(port)}`).catch(() => undefined);
}

async function pageSocketUrl(port) {
  const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json`, { signal: AbortSignal.timeout(5000) })).json();
  const page = targets.find((/** @type {any} */ target) => target.type === 'page');
  return typeof page?.webSocketDebuggerUrl === 'string' ? /** @type {string} */ (page.webSocketDebuggerUrl) : null;
}

/** Sends commands and resolves with the replies, on one socket. */
function openSession(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let next = 0;
    const waiting = new Map();
    const listeners = [];
    socket.onerror = () => reject(new Error('the DevTools socket could not be opened'));
    socket.onmessage = (event) => {
      // A bad message or a listener that throws (a full disk) must not end the recorder: this runs outside every try below.
      try {
        const message = JSON.parse(String(event.data));
        if (typeof message.id === 'number' && waiting.has(message.id)) {
          waiting.get(message.id)(message);
          waiting.delete(message.id);
        } else {
          for (const listener of listeners) listener(message);
        }
      } catch {
        // dropped
      }
    };
    socket.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((done) => {
            next += 1;
            waiting.set(next, done);
            // No answer (the app died, the socket is closing) must not wait forever.
            setTimeout(() => done({ error: 'no answer' }), 5000).unref();
            try {
              socket.send(JSON.stringify({ id: next, method, params }));
            } catch {
              done({ error: 'not sent' });
            }
          }),
        onEvent: (listener) => listeners.push(listener),
        onClose: (listener) => { socket.onclose = listener; },
        close: () => socket.close(),
      });
  });
}

async function collect(file, seconds) {
  writeFileSync(file, '');
  const note = (kind, text) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind, level: 'info', text })}\n`);
  let stopping = false;
  let connections = 0;
  const stop = () => {
    stopping = true;
    // At once: the loop may be waiting on something that never answers, and whoever sent the signal is waiting for this process.
    note('collector', `stopped after ${String(connections)} connection(s)`);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Whatever else goes wrong in here must not end the recording (the record would then look like "the page printed nothing").
  process.on('uncaughtException', () => undefined);
  process.on('unhandledRejection', () => undefined);
  const deadline = seconds > 0 ? Date.now() + seconds * 1000 : Infinity;
  note('collector', 'started');
  while (!stopping && Date.now() < deadline) {
    try {
      const target = await forwardedPort();
      const url = target === null ? null : await pageSocketUrl(target[1]);
      if (url === null) {
        if (target !== null) await dropForward(target[0]);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const session = await openSession(url);
      connections += 1;
      note('collector', `connected (${String(connections)})`);
      const closed = new Promise((r) => session.onClose(r));
      session.onEvent((message) => {
        const line = describeEvent(message, Date.now());
        if (line !== null) appendFileSync(file, `${JSON.stringify(line)}\n`);
      });
      await session.send('Runtime.enable');
      await session.send('Log.enable');
      while (!stopping && Date.now() < deadline) {
        if ((await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('tick'), 500))])) === 'closed') break;
      }
      session.close();
      await dropForward(target[0]);
      note('collector', 'disconnected');
    } catch {
      // The app is starting, restarting or gone: look again.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  note('collector', `stopped after ${String(connections)} connection(s)`);
}

async function snapshot(file) {
  const target = await forwardedPort();
  const url = target === null ? null : await pageSocketUrl(target[1]);
  if (url === null) {
    if (target !== null) await dropForward(target[0]);
    writeFileSync(file, 'no page could be reached through DevTools\n');
    return 1;
  }
  const session = await openSession(url);
  const read = async (expression) => {
    const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true });
    return String(reply.result?.result?.value ?? '');
  };
  const text = [`title: ${await read('document.title')}`, `address: ${withoutQuery(await read('location.href'))}`, '--- visible text ---', await read('document.body ? document.body.innerText : ""')].join('\n');
  writeFileSync(file, `${text}\n`);
  session.close();
  await dropForward(target[0]);
  return 0;
}

if (process.argv[1]?.endsWith('webview-console.mjs')) {
  const [mode, file, seconds] = process.argv.slice(2);
  if (file === undefined || (mode !== 'collect' && mode !== 'snapshot')) {
    console.error('usage: webview-console.mjs collect <file> [seconds] | snapshot <file>');
    process.exit(2);
  }
  const code = mode === 'collect' ? (await collect(file, Number(seconds ?? 0)), 0) : await snapshot(file).catch(() => 1);
  process.exit(code);
}
