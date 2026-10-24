import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Browser builtins throw `Illegal invocation` in a WebView when they are called with any `this` but the
 * window. Putting one into an object literal or a variable and calling it from there does exactly that,
 * and Node never complains. Writing an arrow wrapper (`(...a) => setTimeout(...a)`) is the safe form.
 */
const BUILTINS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'queueMicrotask', 'atob', 'btoa', 'structuredClone', 'requestAnimationFrame', 'cancelAnimationFrame'];

const REFERENCE = new RegExp(`(?<![.\\w$'"\`])(?<!typeof\\s)(?:${BUILTINS.join('|')})(?=\\s*(?:[,;})\\]]|\\?\\?|\\|\\||$))`, 'm');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Lines that hold a builtin as a value (not called, not a type, not a member). */
function detachedBuiltinReferences(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .filter((line) => REFERENCE.test(line))
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
