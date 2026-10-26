import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Browser builtins throw `Illegal invocation` in a WebView when they are called with any `this` but the
 * window. Putting one into an object literal or a variable and calling it from there does exactly that,
 * and Node never complains. Writing an arrow wrapper (`(...a) => setTimeout(...a)`) is the safe form.
 */
const BUILTINS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'queueMicrotask', 'atob', 'btoa', 'structuredClone', 'requestAnimationFrame', 'cancelAnimationFrame'];

const NAMES = BUILTINS.join('|');
const NOT_A_CALL = String.raw`(?!\s*(?:\?\.)?\()`;
const NOT_TYPEOF = String.raw`(?<!typeof\s)`;

const REFERENCES = [
  // A bare name used as a value: in a list or object, assigned, defaulted, bound, cast, or a ternary arm.
  new RegExp(String.raw`(?<![.\w$'"` + '`' + String.raw`])${NOT_TYPEOF}(?:${NAMES})(?=\s*(?:[,;})\]]|\?\?|\|\||$|\.bind\b|\s(?:as|satisfies)\s))`, 'm'),
  new RegExp(String.raw`(?<=\?\s*)(?:${NAMES})(?=\s*:)`),
  // A member of the window that is read but not called: `window.fetch`, `globalThis.setTimeout.bind(...)`.
  new RegExp(String.raw`(?<![\w$])${NOT_TYPEOF}(?:window|globalThis|self)\.(?:${NAMES})\b${NOT_A_CALL}`),
  // A method of crypto that is read but not called: `crypto.getRandomValues`, `globalThis.crypto.randomUUID`.
  new RegExp(String.raw`(?<![\w$])${NOT_TYPEOF}(?:[\w$]+\.)*crypto\.(?:getRandomValues|randomUUID)\b${NOT_A_CALL}`),
];

/**
 * Removes comments and the contents of string and template literals (the quotes stay), so a `//` inside a
 * string cannot hide code after it and a builtin named inside a string is not mistaken for a reference.
 * Newlines are kept, so line numbers survive.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== ch && (ch === '`' || source[i] !== '\n')) {
        if (source[i] === '\\') i += 1;
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      if (source[i] === ch) {
        out += ch;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Lines that hold a builtin as a value (not called, not a type, not a mention in text). */
function detachedBuiltinReferences(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .filter((line) => REFERENCES.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !path.includes('test-support') ? [path] : [];
  });
}

describe('detached builtins guard', () => {
  it('flags builtins stored in objects or variables (positive control)', () => {
    expect(detachedBuiltinReferences('const timers = deps.timers ?? { setTimeout, clearTimeout };')).not.toEqual([]);
    expect(detachedBuiltinReferences('const t = { setTimeout: setTimeout, clearTimeout: clearTimeout };')).not.toEqual([]);
    expect(detachedBuiltinReferences('const deps = { fetch,\n  other };')).not.toEqual([]);
    expect(detachedBuiltinReferences('const f = fetch;')).not.toEqual([]);
    expect(detachedBuiltinReferences('const wait = deps.wait ?? setTimeout\n')).not.toEqual([]);
  });

  it('flags every member and wrapper form that stores a builtin (positive control)', () => {
    const shapes = [
      'const t = { f: window.fetch };',
      'const f = globalThis.fetch;',
      'const t = { setTimeout: globalThis.setTimeout };',
      'const f = setTimeout.bind(globalThis);',
      'const f = globalThis.fetch.bind(globalThis);',
      'const f = cond ? setTimeout : other;',
      'const f = cond ? other : setTimeout;',
      'const f = fetch as typeof fetch;',
      'const g = crypto.getRandomValues;',
      'const o = { g: crypto.getRandomValues, u: globalThis.crypto.randomUUID };',
      "const s = 'a//b'; const f = globalThis.fetch;",
      'const s = "a//b"; const f = fetch;',
      'const s = `a//b`; const f = fetch;',
    ];
    for (const shape of shapes) expect(detachedBuiltinReferences(shape), shape).not.toEqual([]);
  });

  it('does not flag legitimate calls or mentions (negative control)', () => {
    const fine = [
      'const t = setTimeout(() => undefined, 1);',
      'const r = window.fetch(url);',
      'crypto.getRandomValues(buf);',
      'const t = globalThis.setTimeout(fn, 1);',
      'const t = globalThis.setTimeout (fn, 1);',
      'const id = crypto.randomUUID();',
      'const r = await globalThis.fetch(url, { method: "GET" });',
      "const s = 'a//b'; setTimeout(() => undefined, 1);",
      "const label = 'fetch, setTimeout, globalThis.fetch';",
      'type T = typeof globalThis.fetch;',
      'const r = cond ? fetch(a) : fetch(b);',
    ];
    for (const line of fine) expect(detachedBuiltinReferences(line), line).toEqual([]);
  });

  it('stripComments keeps code after a string that contains two slashes, and still drops real comments', () => {
    expect(stripComments("const s = 'a//b'; const f = fetch;")).toContain('const f = fetch;');
    expect(stripComments('const f = fetch; // trailing')).not.toContain('trailing');
    expect(stripComments('/* block\nfetch */ const x = 1;')).not.toContain('fetch');
    expect(stripComments('const url = "http://x.test"; const f = fetch;')).toContain('const f = fetch;');
  });

  it('accepts calls, arrow wrappers, member access and types (negative control)', () => {
    const fine = [
      'const t = setTimeout(() => undefined, 1);',
      'const timers = { setTimeout: (...a) => setTimeout(...a) };',
      'timer: ReturnType<typeof setTimeout> | undefined;',
      'timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };',
      'fetch: (input, init) => fetch(input, init),',
      'fetch: parts.fetch,',
      '// a comment that says { setTimeout, clearTimeout }',
    ];
    for (const line of fine) expect(detachedBuiltinReferences(line)).toEqual([]);
  });

  it('finds none in the app source', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src')).flatMap((file) => detachedBuiltinReferences(readFileSync(file, 'utf8')).map((line) => `${file}: ${line}`));
    expect(offenders).toEqual([]);
  });
});
