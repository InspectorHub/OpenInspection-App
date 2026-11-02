import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ABORT_SIGNALS, APP_KEY, SCRATCH_KEY, VERIFY_FAILED_EXIT_CODE, installAbortHandlers, keyExists, keyExistsWith, looksLikeLeftover, withRegistryGuard,
} from './registry-guard.mjs';

// These tests touch ONLY the scratch key. The real io.inspectorhub.app key is never read, written or exported.
const reg = (...args: string[]) => execFileSync('reg.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
const addValue = (subkey: string, name: string, data: string) => reg('add', subkey === '' ? SCRATCH_KEY : `${SCRATCH_KEY}\\${subkey}`, '/v', name, '/t', 'REG_SZ', '/d', data, '/f');
const dump = (): string => reg('query', SCRATCH_KEY, '/s');
const deleteScratch = () => { try { reg('delete', SCRATCH_KEY, '/f'); } catch { /* absent */ } };

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'oi-registry-guard-test-')); dirs.push(d); return d; };
const quiet = { log: () => undefined };
/** Options for one guarded run: its own backup directory AND its own lock directory, so tests never see each other's locks. */
const own = () => ({ backupDir: tmp(), lockDir: tmp(), ...quiet });
const FIXTURE = join(__dirname, 'fixtures', 'registry-guard-uncaught.mjs');

describe.skipIf(process.platform !== 'win32')('registry guard', () => {
  afterEach(deleteScratch);
  afterAll(() => {
    deleteScratch();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('restores a key byte for byte when the guarded function changes it and throws', async () => {
    deleteScratch();
    addValue('', 'Probe', 'original value');
    addValue('shell\\open\\command', '', '"C:\\real\\InspectorHub.exe" "%1"');
    const before = dump();
    const boom = new Error('guarded function failed');
    await expect(withRegistryGuard([SCRATCH_KEY], () => {
      addValue('', 'Probe', 'changed by the run');
      addValue('shell\\open\\command', '', '"D:\\tmp\\other.exe" "%1"');
      addValue('extra-subkey', 'Added', 'x');
      throw boom;
    }, own())).rejects.toBe(boom);
    expect(dump()).toBe(before);
  });

  it('restores a key byte for byte when the guarded function returns normally, and hands back its result', async () => {
    deleteScratch();
    addValue('', 'Probe', 'original value');
    addValue('shell\\open\\command', '', '"C:\\real\\InspectorHub.exe" "%1"');
    const before = dump();
    const result = await withRegistryGuard([SCRATCH_KEY], () => {
      addValue('', 'Probe', 'changed by the run');
      addValue('shell\\open\\command', '', '"D:\\tmp\\other.exe" "%1"');
      return 42;
    }, own());
    expect(result).toBe(42);
    expect(dump()).toBe(before);
  });

  it('restores a value of another type than REG_SZ as that type (REG_EXPAND_SZ is not turned into REG_SZ)', async () => {
    deleteScratch();
    reg('add', SCRATCH_KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%SystemRoot%\\expanded', '/f');
    const before = dump();
    expect(before).toContain('REG_EXPAND_SZ');
    await withRegistryGuard([SCRATCH_KEY], () => { reg('add', SCRATCH_KEY, '/v', 'Path', '/t', 'REG_SZ', '/d', 'plain', '/f'); }, own());
    expect(dump()).toBe(before);
  });

  it('deletes a key that did not exist before and the guarded function created', async () => {
    deleteScratch();
    expect(keyExists(SCRATCH_KEY)).toBe(false);
    const result = await withRegistryGuard([SCRATCH_KEY], () => { addValue('shell', 'Made', 'by the run'); return 'ok'; }, own());
    expect(result).toBe('ok');
    expect(keyExists(SCRATCH_KEY)).toBe(false);
  });

  it('fails loudly with exit code 3 and the differing lines when the restore does not match the backup', async () => {
    deleteScratch();
    addValue('', 'Probe', 'original value');
    const err = await withRegistryGuard([SCRATCH_KEY], () => undefined, {
      ...own(),
      // Tamper with the backup file after it was taken: the restore imports the wrong content.
      afterBackup: (saved: { file: string }[]) => {
        const file = saved[0]!.file;
        const text = readFileSync(file).toString('utf16le').replace('original value', 'TAMPERED value');
        writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/^\uFEFF/, ''), 'utf16le')]));
      },
    }).then(() => undefined, (e: unknown) => e as { exitCode: number; message: string; diff: string[] });
    expect(err).toBeDefined();
    expect(err!.exitCode).toBe(VERIFY_FAILED_EXIT_CODE);
    expect(err!.diff.some((line) => line.startsWith('- ') && line.includes('original value'))).toBe(true);
    expect(err!.diff.some((line) => line.startsWith('+ ') && line.includes('TAMPERED value'))).toBe(true);
  });

  it('rejects a key that is not on the allow-list before anything runs', async () => {
    let ran = false;
    for (const key of ['HKCU\\Software\\Classes\\io.inspectorhub.smoke-not-allowed', 'HKCU\\Software\\Classes\\io.inspectorhub.smoke-scratch-evil', 'HKLM\\Software\\Classes\\io.inspectorhub.smoke-scratch', '']) {
      await expect(withRegistryGuard([SCRATCH_KEY, key], () => { ran = true; }, own())).rejects.toThrow(/allow-list/);
    }
    expect(ran).toBe(false);
    expect(keyExists(SCRATCH_KEY)).toBe(false);
    expect(APP_KEY).toBe('HKCU\\Software\\Classes\\io.inspectorhub.app');
  });

  describe('a second run, and a run that died', () => {
    it('a second guarded run on the same key while the first is running is refused, and the first still restores', async () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const before = dump();
      const lockDir = tmp();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let secondRan = false;
      const first = withRegistryGuard([SCRATCH_KEY], async () => { addValue('', 'Probe', 'changed by the first'); await gate; }, { backupDir: tmp(), lockDir, ...quiet });
      await new Promise((r) => setTimeout(r, 300)); // the first has taken its backup and changed the key
      await expect(withRegistryGuard([SCRATCH_KEY], () => { secondRan = true; }, { backupDir: tmp(), lockDir, ...quiet })).rejects.toThrow(/in progress/);
      expect(secondRan).toBe(false);
      release();
      await first;
      expect(dump()).toBe(before); // not the first's modified state taken over as the original
    });

    it('a lock left by a dead run refuses the next run, names the backup and the commands that restore it, and leaves the key alone', async () => {
      deleteScratch();
      addValue('', 'Probe', 'a state the dead run left behind');
      const before = dump();
      const lockDir = tmp();
      const backupDir = tmp();
      const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!; // exited already: its pid is not alive
      const lockFile = join(lockDir, 'oi-registry-guard-hkcu-software-classes-io-inspectorhub-smoke-scratch.lock');
      const backupFile = join(backupDir, 'backup-0.reg');
      writeFileSync(lockFile, JSON.stringify({ key: SCRATCH_KEY, pid: deadPid, startedAt: '2026-11-01T00:00:00.000Z', backupDir, backups: [{ file: backupFile, existedBefore: true }] }));
      let ran = false;
      const err = await withRegistryGuard([SCRATCH_KEY], () => { ran = true; }, { backupDir: tmp(), lockDir, ...quiet }).then(() => undefined, (e: unknown) => e as { exitCode: number; message: string });
      expect(ran).toBe(false);
      expect(err?.exitCode).toBe(VERIFY_FAILED_EXIT_CODE);
      expect(err?.message).toContain(backupFile);
      expect(err?.message).toContain('reg import');
      expect(err?.message).toContain('WITHOUT a verified restore');
      expect(existsSync(lockFile)).toBe(true); // only the person deletes it, after restoring
      expect(dump()).toBe(before);
    });

    it('a failed restore keeps the lock, so the next run cannot take the modified key for the original', async () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const lockDir = tmp();
      await expect(withRegistryGuard([SCRATCH_KEY], () => undefined, {
        backupDir: tmp(), lockDir, ...quiet,
        afterBackup: (saved: { file: string }[]) => {
          const text = readFileSync(saved[0]!.file).toString('utf16le').replace('original value', 'TAMPERED value');
          writeFileSync(saved[0]!.file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/^\uFEFF/, ''), 'utf16le')]));
        },
      })).rejects.toThrow(/restore failed/);
      await expect(withRegistryGuard([SCRATCH_KEY], () => undefined, { backupDir: tmp(), lockDir, ...quiet })).rejects.toThrow(/in progress|WITHOUT a verified restore/);
    });

    it('control: after a verified restore the lock is gone and the same key can be guarded again', async () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const lockDir = tmp();
      await withRegistryGuard([SCRATCH_KEY], () => undefined, { backupDir: tmp(), lockDir, ...quiet });
      await expect(withRegistryGuard([SCRATCH_KEY], () => 'again', { backupDir: tmp(), lockDir, ...quiet })).resolves.toBe('again');
    });

    it('a backup directory that already holds a backup is refused: it may be the only copy of an original', async () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const backupDir = tmp();
      writeFileSync(join(backupDir, 'backup-0.reg'), 'an earlier run\'s backup');
      let ran = false;
      await expect(withRegistryGuard([SCRATCH_KEY], () => { ran = true; }, { backupDir, lockDir: tmp(), ...quiet })).rejects.toThrow(/already holds a backup/);
      expect(ran).toBe(false);
      expect(readFileSync(join(backupDir, 'backup-0.reg'), 'utf8')).toBe('an earlier run\'s backup');
    });
  });

  describe('the real app key in CI', () => {
    it('is refused when CI or GITHUB_ACTIONS is set at all, even to an empty string, before any registry call', async () => {
      let ran = false;
      for (const env of [{ CI: 'true' }, { CI: '' }, { GITHUB_ACTIONS: 'true' }, { GITHUB_ACTIONS: '' }]) {
        await expect(withRegistryGuard([APP_KEY], () => { ran = true; }, { backupDir: tmp(), lockDir: tmp(), env, ...quiet })).rejects.toThrow(/in CI/);
      }
      expect(ran).toBe(false);
    });

    it('control: the scratch key is not refused in CI (this very suite runs there)', async () => {
      deleteScratch();
      await expect(withRegistryGuard([SCRATCH_KEY], () => 'ran', { ...own(), env: { CI: 'true' } })).resolves.toBe('ran');
    });
  });

  describe('a stop in the middle of a run', () => {
    it('on Ctrl+C the key is back, verified, BEFORE the process exits, and what the run started is stopped first', async () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const before = dump();
      const proc = Object.assign(new EventEmitter(), { exit: (code: number) => { exits.push(code); } });
      const exits: number[] = [];
      const order: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const run = withRegistryGuard([SCRATCH_KEY], async () => { addValue('', 'Probe', 'changed by the run'); await gate; }, {
        ...own(), proc, onAbort: () => { order.push('onAbort'); },
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(dump()).not.toBe(before);
      proc.emit('SIGINT');
      // Synchronous: no await between the signal and this check, exactly what a process that is about to exit gets.
      expect(dump()).toBe(before);
      expect(order).toEqual(['onAbort']);
      expect(exits).toEqual([130]);
      release();
      await run;
    });

    it('a process that dies from an uncaught exception outside the awaited chain still gets its key back', () => {
      deleteScratch();
      addValue('', 'Probe', 'original value');
      const before = dump();
      const lockDir = tmp();
      const backupDir = join(tmp(), 'b');
      mkdirSync(backupDir);
      const child = spawnSync(process.execPath, [FIXTURE, lockDir, backupDir], { encoding: 'utf8', windowsHide: true });
      expect(child.status).not.toBe(0); // it really died
      expect(`${child.stderr}`).toContain('uncaught, outside the awaited chain');
      expect(dump()).toBe(before); // the key is back, including the subkey the child added
      expect(existsSync(join(lockDir, 'oi-registry-guard-hkcu-software-classes-io-inspectorhub-smoke-scratch.lock'))).toBe(false);
    });
  });

  describe('keyExists', () => {
    const failing = (status: number) => () => Object.assign(new Error(`reg.exe exited ${String(status)}`), { status });

    it('says absent only when the parent key can still be read', () => {
      const query = (args: string[]) => { if (args[1] === SCRATCH_KEY) throw failing(1)(); return Buffer.from(''); };
      expect(keyExistsWith(query, SCRATCH_KEY)).toBe(false);
    });

    it('does NOT say absent when reg.exe fails the same way for the parent (an access error reads like "not found" otherwise)', () => {
      const query = (args: string[]) => { throw failing(args[1] === SCRATCH_KEY ? 1 : 5)(); };
      expect(() => keyExistsWith(query, SCRATCH_KEY)).toThrow(/cannot read HKCU\\Software\\Classes/);
    });

    it('does not turn another failure of the key query itself into "absent"', () => {
      expect(() => keyExistsWith(() => { throw failing(5)(); }, SCRATCH_KEY)).toThrow(/exited 5/);
    });

    it('says present when the query succeeds', () => {
      expect(keyExistsWith(() => Buffer.from(''), SCRATCH_KEY)).toBe(true);
    });
  });
});

// Pure logic: runs on any platform.
describe('installAbortHandlers', () => {
  const make = () => {
    const exits: number[] = [];
    const proc = Object.assign(new EventEmitter(), { exit: (code: number) => { exits.push(code); } });
    const calls: string[] = [];
    return { proc, exits, calls };
  };

  it('runs the restore once for a signal and exits with the signal\'s code, and never again for a second signal or the exit that follows', () => {
    const { proc, exits, calls } = make();
    installAbortHandlers({ proc, restore: (why: string) => { calls.push(why); return 0; } });
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    proc.emit('exit', 130);
    expect(calls).toEqual(['SIGINT']);
    expect(exits).toEqual([130, 130]);
  });

  it('exits 143 for the other signals and 3 when the restore found a problem', () => {
    for (const [signal, problems, code] of [['SIGTERM', 0, 143], ['SIGHUP', 0, 143], ['SIGBREAK', 0, 143], ['SIGINT', 1, VERIFY_FAILED_EXIT_CODE], ['SIGTERM', 2, VERIFY_FAILED_EXIT_CODE]] as const) {
      const { proc, exits } = make();
      installAbortHandlers({ proc, restore: () => problems });
      proc.emit(signal);
      expect(exits, `${signal} ${String(problems)}`).toEqual([code]);
    }
  });

  it('a restore that throws still ends the process with the failure code, not a hang', () => {
    const { proc, exits } = make();
    installAbortHandlers({ proc, restore: () => { throw new Error('restore blew up'); } });
    proc.emit('SIGINT');
    expect(exits).toEqual([VERIFY_FAILED_EXIT_CODE]);
  });

  it('restores on a plain exit (an uncaught exception, process.exit somewhere else) without calling exit itself', () => {
    const { proc, exits, calls } = make();
    installAbortHandlers({ proc, restore: (why: string) => { calls.push(why); return 0; } });
    proc.emit('exit', 1);
    expect(calls).toEqual(['exit']);
    expect(exits).toEqual([]);
  });

  it('handles every signal in the list, and removes every handler it added', () => {
    const { proc, calls } = make();
    const uninstall = installAbortHandlers({ proc, restore: (why: string) => { calls.push(why); return 0; } });
    for (const signal of ABORT_SIGNALS) expect(proc.listenerCount(signal), signal).toBe(1);
    expect(proc.listenerCount('exit')).toBe(1);
    uninstall();
    for (const signal of ABORT_SIGNALS) expect(proc.listenerCount(signal), signal).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
    proc.emit('SIGINT');
    expect(calls).toEqual([]);
  });
});

describe('looksLikeLeftover (the open command the smoke script refuses to back up)', () => {
  it.each([
    ['an unpacked build left behind', '"D:\\tmp\\win-smoke\\release\\win-unpacked\\InspectorHub.exe" "%1"', true],
    ['a smoke work directory', '"C:\\Users\\x\\AppData\\Local\\Temp\\oi-win-smoke-ab12\\InspectorHub.exe" "%1"', true],
    ['any other temp directory', '"C:\\Users\\x\\AppData\\Local\\Temp\\other\\a.exe" "%1"', true],
    ['the case of the path is not a difference', '"d:\\TMP\\WIN-UNPACKED\\inspectorhub.exe" "%1"', true],
    ['control: the real installed app', '"C:\\Users\\important-new\\AppData\\Local\\Programs\\openinspection-app\\InspectorHub.exe" "%1"', false],
    ['control: a path that merely contains the letters', '"C:\\Program Files\\Temporal\\InspectorHub.exe" "%1"', false],
    ['control: no command at all', null, false],
  ] as const)('%s', (_name, command, expected) => {
    expect(looksLikeLeftover(command)).toBe(expected);
  });
});
