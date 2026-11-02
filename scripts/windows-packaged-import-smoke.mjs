// Manual smoke test of the PACKAGED Windows build: sign in to the fake engine over HTTPS, then import a small and a
// ~22 MiB incompressible package through Settings > Import package and compare what the engine received with the file.
//
//   node scripts/windows-packaged-import-smoke.mjs --app <dir>\InspectorHub.exe --allow-registry-change --out <dir>
//
// SIDE EFFECT: starting the packaged exe rewrites HKCU\Software\Classes\io.inspectorhub.app of the machine's real
// installed app (app.setAsDefaultProtocolClient). The whole run is wrapped in withRegistryGuard, which backs the key up,
// restores it afterwards (also when the run fails, on Ctrl+C or a closed terminal, and on an uncaught exception) and
// verifies the restore. If the process is killed outright nothing can run: the guard's lock file then makes the NEXT run
// refuse to start and name the backup (see scripts/lib/registry-guard.mjs). Exit codes: 0 pass, 1 a check failed or bad
// usage, 3 the registry key could NOT be restored identically (the diff and the commands that restore it by hand are
// printed). Manual only: it refuses to run in CI and no workflow mentions it.
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { expect } from '@playwright/test';
import { APP_KEY, RegistryGuardError, looksLikeLeftover, withRegistryGuard } from './lib/registry-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { makePackage } = await import(new URL('../src/offline/test-support/import-fixtures.ts', import.meta.url).href);

const USAGE = 'usage: node scripts/windows-packaged-import-smoke.mjs --app <path to unpacked InspectorHub.exe> --allow-registry-change --out <dir> [--port 9333]';
const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' }, port: { type: 'string', default: '9333' }, 'allow-registry-change': { type: 'boolean', default: false } }, strict: true });

function usageError(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(1);
}
if (process.platform !== 'win32') usageError('This smoke test only runs on Windows.');
if (process.env.CI !== undefined || process.env.GITHUB_ACTIONS !== undefined) usageError("Refusing to run in CI: this is a manual test that rewrites a machine's real app registration.");
if (values.app === undefined || values['allow-registry-change'] !== true) {
  usageError('Refusing to run: --app and --allow-registry-change are both required.\nThis run starts the packaged exe, which rewrites '
    + `${APP_KEY}\\shell\\open\\command (the machine's real installed app), and restores it afterwards.`);
}
if (values.out === undefined) usageError('--out <dir> is required (results.json and screenshots go there).');
const EXE = resolve(values.app);
if (basename(EXE).toLowerCase() !== 'inspectorhub.exe' || !existsSync(EXE)) usageError(`--app must be an existing InspectorHub.exe, got ${EXE}`);
const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs').toLowerCase();
if (installed !== 'programs' && EXE.toLowerCase().startsWith(installed)) usageError(`Refusing to run the installed app (${EXE}); pass an unpacked build directory.`);
const PORT = Number(values.port);
const OUT = resolve(values.out);
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); appendFileSync(join(OUT, 'smoke.log'), `${l}\n`); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const COMMAND_KEY = `${APP_KEY}\\shell\\open\\command`;
function readOpenCommand() {
  try {
    const text = execFileSync('reg.exe', ['query', COMMAND_KEY, '/ve'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
    return (/REG_SZ\s+(.*)\r?$/m.exec(text)?.[1] ?? text).trim();
  } catch { return null; }
}
// A command that already points at a build or temp path is the leftover of an earlier run (or of starting the packaged exe by hand).
// Backing that up would bless it as "the original", so it is refused here whatever the lock file says.
const OPEN_COMMAND_NOW = readOpenCommand();
if (looksLikeLeftover(OPEN_COMMAND_NOW)) {
  usageError(`Refusing to run: ${COMMAND_KEY} already points at a build or temp path, which looks like the leftover of an earlier run or of starting the packaged exe by hand:\n  ${OPEN_COMMAND_NOW}\nRestore the real installed app's registration first (reinstall it, or run the installed app once), then run this again.`);
}
const portInUse = (port) => new Promise((done) => { const s = createConnection({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); done(true); }); s.once('error', () => done(false)); });

const workDir = mkdtempSync(join(tmpdir(), 'oi-win-smoke-'));
const USERDATA = join(workDir, 'userdata');
mkdirSync(USERDATA);
const started = []; // only pids this script started
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out after ${String(ms / 1000)} s: ${what}`)), ms).unref(); })]);
// When tasklist cannot tell, the pid counts as alive: a leaked process is reported, never hidden.
const pidAlive = (pid) => { try { return execFileSync('tasklist.exe', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().includes(`"${String(pid)}"`); } catch { return true; } };
/** Stops every process this script started (with its children), synchronously, and returns the pids that are STILL running afterwards. */
function killStarted() {
  const pids = started.filter((pid) => Number.isInteger(pid));
  for (const pid of [...pids].reverse()) { try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already exited, or refused: the check below says which */ } }
  return pids.filter(pidAlive);
}
// If anything hangs for good, end the process: the guard's exit handler then stops the app and restores the registry.
setTimeout(() => { console.error('WATCHDOG: the run took longer than 15 minutes'); process.exit(1); }, 15 * 60 * 1000).unref();
const results = { app: EXE, startedAt: new Date().toISOString(), registry: {}, imports: [], notFound404: [], rendererErrors: [], failed: null };

async function readLine(child) {
  let text = '';
  for await (const chunk of child.stdout) { text += String(chunk); if (text.includes('\n')) break; }
  return JSON.parse(text);
}

async function run() {
  let browser;
  try {
    const engine = spawn(process.execPath, [join(ROOT, 'e2e/fake-engine/serve.mjs'), '--scenario', 'inspection', '--tls-cert', join(ROOT, 'e2e-electron/fixtures/loopback-cert.pem'), '--tls-key', join(ROOT, 'e2e-electron/fixtures/loopback-key.pem')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    started.push(engine.pid);
    engine.stderr.on('data', (c) => log(`engine stderr: ${c}`));
    const { origin, control } = await withTimeout(readLine(engine), 30000, 'the fake engine did not print its address');
    log(`engine ${origin} control ${control}`);

    if (await portInUse(PORT)) throw new Error(`port ${String(PORT)} is already in use; pass --port <free port>`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const userFlag = `--user-data-dir=${USERDATA}`;
    // Fuses forbid Playwright's _electron.launch, so start the exe and attach over CDP. The self-signed engine certificate
    // is accepted only because of --ignore-certificate-errors; the packaged CSP allows only https/wss for connect-src.
    const app = spawn(EXE, [userFlag, `--remote-debugging-port=${String(PORT)}`, '--ignore-certificate-errors'], { env, stdio: 'ignore' });
    started.push(app.pid);
    log(`app pid ${String(app.pid)} user-data-dir ${USERDATA}`);

    let page;
    for (let i = 0; i < 60 && !page; i++) {
      await sleep(1000);
      try {
        browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${String(PORT)}`);
        page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('https://localhost'));
      } catch { browser = undefined; }
    }
    if (!page) throw new Error('app window not found over CDP');
    log(`page ${page.url()}`);
    results.registry.during = readOpenCommand();
    log(`registry DURING the run: ${results.registry.during}`);

    page.on('console', (m) => { if (m.type() === 'error') results.rendererErrors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => results.rendererErrors.push(`pageerror: ${e.message}`));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    cdp.on('Network.responseReceived', (e) => { if (e.response.status === 404) results.notFound404.push({ source: 'network', url: e.response.url, type: e.type }); });
    cdp.on('Log.entryAdded', (e) => { if (/404/.test(e.entry.text)) results.notFound404.push({ source: 'log', url: e.entry.url ?? null, text: e.entry.text }); });
    await page.reload(); // so the listeners see the initial asset loads of the packaged renderer too
    await page.waitForLoadState('load');

    // sign in: capture the state the renderer puts in the authorize URL
    await page.evaluate(() => {
      const original = URLSearchParams.prototype.toString;
      URLSearchParams.prototype.toString = function () { const s = original.call(this); if (s.includes('code_challenge=') && this.get('state')) window.__oiState = this.get('state'); return s; };
    });
    await expect(page.getByLabel('Server address')).toBeVisible({ timeout: 30000 });
    await page.getByLabel('Server address').fill(origin);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Connect to this server?' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 30000 });
    log('https fake engine accepted by the packaged build (reached the Sign in screen)');
    // shell.openExternal opens the DEFAULT BROWSER on the fake engine's self-signed page here; close that tab afterwards.
    await page.getByRole('button', { name: 'Sign in' }).click();
    let state;
    for (let i = 0; i < 30 && !state; i++) { state = await page.evaluate(() => window.__oiState); if (!state) await sleep(500); }
    if (!state) throw new Error('state not captured');
    const callback = `io.inspectorhub.app:/oauth/callback?code=renderer-auth-code&state=${encodeURIComponent(state)}`;
    const second = spawn(EXE, [userFlag, callback], { env, stdio: 'ignore' });
    started.push(second.pid);
    await withTimeout(new Promise((r) => second.on('exit', r)), 30000, 'the second launch (the sign-in callback) did not exit');
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 30000 });
    log('signed in');

    const cases = [
      ['small', makePackage({ tenantId: 'renderer-tenant', inspections: 4, photos: { 0: 2, 2: 1 }, updates: { 1: 1 } }), 4],
      ['large', makePackage({ tenantId: 'renderer-tenant', inspections: 11, yjsBytes: 2 * 1024 * 1024 }), 11],
    ];
    for (const [name, made, count] of cases) {
      const file = join(workDir, `export-${name}.zip`);
      writeFileSync(file, made.zip);
      const fileSha = sha(made.zip);
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Import package' }).click();
      await page.getByTestId('import-file-input').setInputFiles(file, { timeout: 240000 });
      await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 60000 });
      await page.getByRole('button', { name: 'Review and import' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(`Inspections: ${String(count)}`);
      const t0 = Date.now();
      await dialog.getByRole('button', { name: 'Import package' }).click();
      await expect(page.getByTestId('import-result')).toBeVisible({ timeout: 180000 });
      const uiMs = Date.now() - t0;
      const headline = (await page.getByTestId('import-headline').innerText()).trim();
      await page.screenshot({ path: join(SHOTS, `result-${name}.png`) });
      const engineState = await (await fetch(`${control}/__test__/state`, { signal: AbortSignal.timeout(15000) })).json();
      const got = engineState.imports.at(-1);
      const expected = `All ${String(count)} inspections were imported.`;
      const r = { name, fileBytes: made.zip.byteLength, fileSha, engineImports: engineState.imports.length, got, shaMatch: got?.sha256 === fileSha, lengthMatch: got?.byteLength === made.zip.byteLength && got?.contentLength === made.zip.byteLength, uiMs, headline, headlineOk: headline === expected, engineErrors: engineState.errors };
      results.imports.push(r);
      log(`RESULT ${JSON.stringify(r)}`);
      rmSync(file, { force: true });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 30000 });
    }
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
    const leaked = killStarted();
    if (leaked.length > 0) { results.leakedPids = leaked; log(`WARNING: still running after taskkill: ${leaked.join(', ')}`); }
    await sleep(1500); // let the killed app release its profile files
  }
}

console.log(`This run will CHANGE the registry key ${COMMAND_KEY}`);
console.log(`(its value now: ${String(readOpenCommand())}). The exe under test rewrites it to point at itself; the key ${APP_KEY} and all subkeys are backed up and RESTORED afterwards, then verified.`);
results.registry.before = readOpenCommand();
let exitCode = 0;
try {
  // A new directory every run: the guard refuses one that already holds a backup, which could be the only copy of an original.
  await withRegistryGuard([APP_KEY], run, { backupDir: join(OUT, 'registry-backup', new Date().toISOString().replace(/[:.]/g, '-')), log, onAbort: killStarted });
} catch (error) {
  results.failed = String(error?.message ?? error);
  log(`FAILED: ${error?.stack ?? error}`);
  exitCode = error instanceof RegistryGuardError ? error.exitCode : 1;
  if (error instanceof RegistryGuardError && error.diff.length > 0) results.registry.diff = error.diff;
} finally {
  results.registry.after = readOpenCommand();
  log(`registry BEFORE: ${String(results.registry.before)}`);
  log(`registry AFTER:  ${String(results.registry.after)}`);
  // Informational (exit code 3 is the authority): "identical" needs a value on both sides, null on both is only "absent before and after".
  results.registry.restoredIdentical = results.registry.before !== null && results.registry.before === results.registry.after && exitCode !== 3;
  results.registry.absentBeforeAndAfter = results.registry.before === null && results.registry.after === null;
  for (let i = 0; i < 5; i++) { try { rmSync(workDir, { recursive: true, force: true }); break; } catch { await sleep(1000); } }
  results.workDirRemoved = !existsSync(workDir);
  const checksOk = results.imports.length === 2 && results.imports.every((r) => r.shaMatch && r.lengthMatch && r.headlineOk) && (results.leakedPids ?? []).length === 0;
  results.passed = results.failed === null && checksOk;
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(results.passed ? 'PASS' : 'FAIL');
  if (exitCode === 0 && !results.passed) exitCode = 1;
}
process.exit(exitCode);
