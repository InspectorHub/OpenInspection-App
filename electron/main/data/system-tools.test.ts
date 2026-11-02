import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../logger.ts';
import { createSystemCommandRunner } from './system-tools.ts';

const SYSTEM_ROOT = 'C:\\Windows';
const SYSTEM32 = `${SYSTEM_ROOT}\\System32`;
const POWERSHELL = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`;

type Done = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;

function harness(options: { env?: { SystemRoot?: string; PATH?: string }; existing?: readonly string[] } = {}) {
  const executed: string[] = [];
  const asked: string[] = [];
  const logged: LogEvent[] = [];
  const existing = new Set((options.existing ?? [
    `${SYSTEM32}\\whoami.exe`, `${SYSTEM32}\\icacls.exe`, `${SYSTEM32}\\fsutil.exe`, POWERSHELL,
  ]).map((path) => path.toLowerCase()));
  const run = createSystemCommandRunner({
    execFile: (file: string, _args: string[], _options: { windowsHide: boolean; encoding: 'utf8' }, done: Done) => {
      executed.push(file);
      done(null, 'ok', '');
    },
    env: options.env ?? { SystemRoot: SYSTEM_ROOT },
    exists: (path) => { asked.push(path); return existing.has(path.toLowerCase()); },
    log: (event) => { logged.push(event); },
  });
  return { run, executed, asked, logged };
}

describe('system tool resolution', () => {
  it.each([
    ['whoami.exe', `${SYSTEM32}\\whoami.exe`],
    ['icacls.exe', `${SYSTEM32}\\icacls.exe`],
    ['fsutil.exe', `${SYSTEM32}\\fsutil.exe`],
    ['powershell.exe', POWERSHELL],
  ])('runs %s from its absolute System32 path', async (name, expected) => {
    const { run, executed } = harness();
    expect(await run(name, ['/x'])).toEqual({ status: 0, stdout: 'ok', stderr: '' });
    expect(executed).toEqual([expected]);
  });

  it('never executes a same-named command that comes earlier on PATH', async () => {
    const hijack = 'C:\\Program Files\\Git\\usr\\bin\\whoami.exe';
    const { run, executed, asked } = harness({
      env: { SystemRoot: SYSTEM_ROOT, PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32' },
      existing: [hijack, `${SYSTEM32}\\whoami.exe`],
    });
    await run('whoami.exe', ['/user']);
    // Positive control: the System32 copy ran. The earlier PATH entry was not run and was not even considered.
    expect(executed).toEqual([`${SYSTEM32}\\whoami.exe`]);
    expect(asked).toEqual([`${SYSTEM32}\\whoami.exe`]);
  });

  it('does not fall back to PATH when the System32 copy is missing', async () => {
    const { run, executed, logged } = harness({
      env: { SystemRoot: SYSTEM_ROOT, PATH: 'C:\\Program Files\\Git\\usr\\bin' },
      existing: ['C:\\Program Files\\Git\\usr\\bin\\whoami.exe'],
    });
    await expect(run('whoami.exe', ['/user'])).rejects.toMatchObject({ code: 'system-tool-unresolved' });
    expect(executed).toEqual([]);
    expect(logged).toEqual(['system-tool-unresolved']);
  });

  it.each([
    ['is not set', undefined],
    ['is empty', ''],
    ['is relative', 'Windows'],
    ['is a parent-relative path', '..\\Windows'],
    ['has no drive', '\\Windows'],
    ['is a bare drive', 'C:'],
  ])('fails closed when SystemRoot %s', async (_label, systemRoot) => {
    const { run, executed, asked, logged } = harness({ env: systemRoot === undefined ? {} : { SystemRoot: systemRoot } });
    await expect(run('icacls.exe', ['C:\\x'])).rejects.toMatchObject({ name: 'SystemToolError', code: 'system-tool-unresolved' });
    expect(executed).toEqual([]);
    expect(asked).toEqual([]);
    expect(logged).toEqual(['system-tool-unresolved']);
  });

  it('fails closed for a tool that is not on the allowlist', async () => {
    const { run, executed, logged } = harness({ existing: [`${SYSTEM32}\\cmd.exe`] });
    await expect(run('cmd.exe', ['/c', 'whoami'])).rejects.toMatchObject({ code: 'system-tool-unresolved' });
    await expect(run('C:\\Users\\evil\\whoami.exe', [])).rejects.toMatchObject({ code: 'system-tool-unresolved' });
    expect(executed).toEqual([]);
    expect(logged).toEqual(['system-tool-unresolved', 'system-tool-unresolved']);
  });

  it('reports a non-zero exit code and a signal-less failure as the command result, not as a resolution error', async () => {
    const run = createSystemCommandRunner({
      execFile: (_file, _args, _options, done) => { done(Object.assign(new Error('exit'), { code: 5 }), '', 'denied'); },
      env: { SystemRoot: SYSTEM_ROOT }, exists: () => true, log: () => undefined,
    });
    expect(await run('icacls.exe', [])).toEqual({ status: 5, stdout: '', stderr: 'denied' });
  });
});

describe('every child process call goes through the resolver', () => {
  const mainRoot = join(import.meta.dirname, '..');
  const desktopRoot = join(import.meta.dirname, '..', '..', '..', 'src', 'desktop');
  const sourceFiles = (root: string): string[] => readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)).map((name) => join(root, name));
  const files = [...sourceFiles(mainRoot), ...sourceFiles(desktopRoot)];
  const rel = (file: string): string => relative(join(mainRoot, '..', '..'), file).split(sep).join('/');
  const importsChildProcess = (text: string): boolean => /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(text);

  it('sees the known child process call sites (positive control)', () => {
    const users = files.filter((file) => importsChildProcess(readFileSync(file, 'utf8'))).map(rel).sort();
    expect(users).toEqual(['electron/main/index.ts', 'electron/main/media/heic-helper-process.ts']);
  });

  it('lets only the main entry (through the resolver) and the bundled HEIC helper spawn processes', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!importsChildProcess(text)) continue;
      if (rel(file) === 'electron/main/index.ts') {
        // The entry hands node's execFile to the resolver and must not call it anywhere else.
        expect(text).toMatch(/createSystemCommandRunner\(\{\s*execFile/);
        expect([...text.matchAll(/\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\(/g)]).toEqual([]);
      } else {
        // The helper is an executable shipped inside the app, addressed by an absolute path that is hash-checked first.
        expect(rel(file)).toBe('electron/main/media/heic-helper-process.ts');
      }
    }
  });

  it('only names system tools that the resolver knows', async () => {
    const names = new Set<string>();
    for (const file of files) {
      if (rel(file) === 'electron/main/data/system-tools.ts') continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/['"]([A-Za-z0-9_-]+\.exe)['"]/g)) names.add(match[1]!);
    }
    names.delete('win-heic-helper.exe'); // The app's own helper, not a system tool.
    // Positive control: the scan finds exactly the four tools the security module launches, and the resolver knows each.
    expect([...names].sort()).toEqual(['fsutil.exe', 'icacls.exe', 'powershell.exe', 'whoami.exe']);
    const executed: string[] = [];
    const run = createSystemCommandRunner({
      execFile: (file, _args, _options, done) => { executed.push(file); done(null, '', ''); },
      env: { SystemRoot: SYSTEM_ROOT }, exists: () => true, log: vi.fn(),
    });
    for (const name of names) await run(name, []);
    expect(executed).toHaveLength(4);
    expect(executed.every((file) => file.startsWith(`${SYSTEM32}\\`))).toBe(true);
  });
});
