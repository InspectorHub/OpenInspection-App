import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ABORT_SIGNALS, APP_KEY, SCRATCH_KEY, SCRATCH_KEY_2, VERIFY_FAILED_EXIT_CODE, defaultLockDir, installAbortHandlers, keyExists, keyExistsWith, looksLikeLeftover, manualRestoreCommand, withRegistryGuard,
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
      let changed: () => void = () => undefined;
      const firstHasChangedTheKey = new Promise<void>((resolve) => { changed = resolve; });
      let secondRan = false;
      const first = withRegistryGuard([SCRATCH_KEY], async () => { addValue('', 'Probe', 'changed by the first'); changed(); await gate; }, { backupDir: tmp(), lockDir, ...quiet });
      await firstHasChangedTheKey; // its own signal: it has taken its backup and changed the key, however slowly this machine got there
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
      let changed: () => void = () => undefined;
      const hasChangedTheKey = new Promise<void>((resolve) => { changed = resolve; });
      const run = withRegistryGuard([SCRATCH_KEY], async () => { addValue('', 'Probe', 'changed by the run'); changed(); await gate; }, {
        ...own(), proc, onAbort: () => { order.push('onAbort'); },
      });
      await hasChangedTheKey;
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

  it('a restore that FAILED on the exit path sets the exit code to 3, whatever the process was exiting with; a good one leaves it alone', () => {
    const bad = make();
    installAbortHandlers({ proc: bad.proc, restore: () => 1 });
    bad.proc.emit('exit', 0);
    expect((bad.proc as unknown as { exitCode?: number }).exitCode).toBe(VERIFY_FAILED_EXIT_CODE);
    const good = make();
    installAbortHandlers({ proc: good.proc, restore: () => 0 });
    good.proc.emit('exit', 1);
    expect((good.proc as unknown as { exitCode?: number }).exitCode).toBeUndefined();
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
  const TMP = 'C:\\Users\\x\\AppData\\Local\\Temp';
  it.each([
    ['an unpacked build left behind', '"D:\\tmp\\win-smoke\\release\\win-unpacked\\InspectorHub.exe" "%1"', true],
    ['a smoke work directory', '"C:\\Users\\x\\AppData\\Local\\Temp\\oi-win-smoke-ab12\\InspectorHub.exe" "%1"', true],
    ['anything under this machine\'s temp directory', '"C:\\Users\\x\\AppData\\Local\\Temp\\other\\a.exe" "%1"', true],
    ['the same with other case and forward slashes', '"c:/users/X/appdata/local/temp/other/a.exe" "%1"', true],
    ['a copy under a folder called tmp that is not a win-unpacked build', '"D:\\tmp\\x\\InspectorHub.exe" "%1"', true],
    ['the case of the path is not a difference', '"d:\\TMP\\WIN-UNPACKED\\inspectorhub.exe" "%1"', true],
    ['control: the real installed app', '"C:\\Users\\important-new\\AppData\\Local\\Programs\\openinspection-app\\InspectorHub.exe" "%1"', false],
    ['control: a Windows account that is itself called Temp (its temp directory is elsewhere)', '"C:\\Users\\Temp\\AppData\\Local\\Programs\\openinspection-app\\InspectorHub.exe" "%1"', false],
    ['control: a path that merely contains the letters', '"C:\\Program Files\\Temporal\\InspectorHub.exe" "%1"', false],
    ['control: the temp directory name as a prefix of another folder', '"C:\\Users\\x\\AppData\\Local\\Temporary\\InspectorHub.exe" "%1"', false],
    ['control: no command at all', null, false],
  ] as const)('%s', (_name, command, expected) => {
    expect(looksLikeLeftover(command, TMP)).toBe(expected);
  });
});

// Pure logic: runs on any platform.
describe('the lock directory and the manual commands', () => {
  it('locks live in a fixed per-user directory, not in the temp directory (which follows TEMP/TMP and is emptied by cleaners)', () => {
    expect(defaultLockDir({ LOCALAPPDATA: 'X:\\Users\\a\\AppData\\Local' })).toBe(join('X:\\Users\\a\\AppData\\Local', 'InspectorHub', 'registry-guard'));
    expect(defaultLockDir({ LOCALAPPDATA: 'X:\\L', TEMP: 'Y:\\other', TMP: 'Z:\\another' })).not.toContain('other');
    expect(defaultLockDir({})).toMatch(/InspectorHub[\\/]registry-guard$/);
  });

  it('the restore by hand is two lines, each pasteable on its own, and one line for a key that did not exist', () => {
    const lines = manualRestoreCommand('HKCU\\K', 'D:\\b\\backup-0.reg', true).split('\n').map((l) => l.trim());
    expect(lines).toEqual(['reg delete "HKCU\\K" /f', 'reg import "D:\\b\\backup-0.reg"']);
    expect(manualRestoreCommand('HKCU\\K', 'D:\\b\\backup-0.reg', false)).toBe('reg delete "HKCU\\K" /f');
  });
});

// Several keys in one run. Only test-only scratch keys are used; the real key is never read, written or exported.
describe.skipIf(process.platform !== 'win32')('a run over several keys', () => {
  const KEYS = [SCRATCH_KEY, SCRATCH_KEY_2];
  const set = (key: string, value: string) => reg('add', key, '/v', 'Probe', '/t', 'REG_SZ', '/d', value, '/f');
  const dumpOf = (key: string): string => reg('query', key, '/s');
  const deleteBoth = () => { for (const key of KEYS) { try { reg('delete', key, '/f'); } catch { /* absent */ } } };
  const tamper = (index: number) => (saved: { file: string }[]) => {
    const file = saved[index]!.file;
    const text = readFileSync(file).toString('utf16le').replace(/ original/, ' TAMPERED');
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/^\uFEFF/, ''), 'utf16le')]));
  };
  const changeBoth = () => { set(SCRATCH_KEY, 'changed by the run'); set(SCRATCH_KEY_2, 'changed by the run'); };

  afterEach(deleteBoth);
  afterAll(deleteBoth);

  it('restores every key and frees every lock when all of them verify', async () => {
    deleteBoth();
    set(SCRATCH_KEY, 'one original');
    set(SCRATCH_KEY_2, 'two original');
    const before = KEYS.map(dumpOf);
    const lockDir = tmp();
    await withRegistryGuard(KEYS, changeBoth, { backupDir: tmp(), lockDir, ...quiet });
    expect(KEYS.map(dumpOf)).toEqual(before);
    // Both locks are gone: each key can be guarded again at once.
    for (const key of KEYS) await expect(withRegistryGuard([key], () => 'again', { backupDir: tmp(), lockDir, ...quiet })).resolves.toBe('again');
  });

  it('a key that did not exist before is deleted again while the other one is restored', async () => {
    deleteBoth();
    set(SCRATCH_KEY, 'one original');
    const before = dumpOf(SCRATCH_KEY);
    await withRegistryGuard(KEYS, changeBoth, { backupDir: tmp(), lockDir: tmp(), ...quiet });
    expect(dumpOf(SCRATCH_KEY)).toBe(before);
    expect(keyExists(SCRATCH_KEY_2)).toBe(false);
  });

  it.each([[0, 1], [1, 0]])('when key %i fails to restore, key %i is still restored and verified, the failure is reported with its own diff, and only the failed key keeps its lock', async (failing, fine) => {
    deleteBoth();
    set(SCRATCH_KEY, 'one original');
    set(SCRATCH_KEY_2, 'two original');
    const before = KEYS.map(dumpOf);
    const lockDir = tmp();
    const err = await withRegistryGuard(KEYS, changeBoth, { backupDir: tmp(), lockDir, ...quiet, afterBackup: tamper(failing) })
      .then(() => undefined, (e: unknown) => e as { exitCode: number; message: string; diff: string[] });
    expect(err).toBeDefined();
    expect(err!.exitCode).toBe(VERIFY_FAILED_EXIT_CODE);
    expect(err!.message).toMatch(/restore failed/);
    expect(err!.diff.some((line) => line.startsWith('- ') && line.includes('original'))).toBe(true);
    expect(err!.diff.some((line) => line.startsWith('+ ') && line.includes('TAMPERED'))).toBe(true);
    // The key that could be restored is back, exactly as it was...
    expect(dumpOf(KEYS[fine]!)).toBe(before[fine]);
    // ...and its lock is gone, so it can be guarded again, while the key that failed still refuses.
    await expect(withRegistryGuard([KEYS[fine]!], () => 'free', { backupDir: tmp(), lockDir, ...quiet })).resolves.toBe('free');
    await expect(withRegistryGuard([KEYS[failing]!], () => 'blocked', { backupDir: tmp(), lockDir, ...quiet })).rejects.toThrow(/in progress|WITHOUT a verified restore/);
  });

  describe('what the review of the guard found', () => {
    const LOCK_1 = 'oi-registry-guard-hkcu-software-classes-io-inspectorhub-smoke-scratch.lock';
    const LOCK_2 = 'oi-registry-guard-hkcu-software-classes-io-inspectorhub-smoke-scratch-two.lock';
    const fakeProc = () => {
      const exits: number[] = [];
      return Object.assign(new EventEmitter(), { exit: (code: number) => { exits.push(code); }, exits });
    };

    it('a key listed twice (or in two cases) is refused by name before anything is locked or touched', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      const before = dumpOf(SCRATCH_KEY);
      const lockDir = tmp();
      let ran = false;
      await expect(withRegistryGuard([SCRATCH_KEY, SCRATCH_KEY.toUpperCase()], () => { ran = true; }, { backupDir: tmp(), lockDir, ...quiet })).rejects.toThrow(/listed twice/);
      expect(ran).toBe(false);
      expect(readdirSync(lockDir)).toEqual([]);
      expect(dumpOf(SCRATCH_KEY)).toBe(before);
    });

    it('a stop while the backups are being taken frees the locks at once: no key was changed, so the next run must not be refused', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      set(SCRATCH_KEY_2, 'two original');
      const before = KEYS.map(dumpOf);
      const lockDir = tmp();
      const proc = fakeProc();
      let lockFilesWhenStopped: string[] = ['(not looked at)'];
      let stopped = false;
      await withRegistryGuard(KEYS, () => undefined, {
        backupDir: tmp(), lockDir, proc,
        // The stop comes when BOTH locks are held but only the first key has been backed up: a restore of what is backed up would free only one.
        log: (message: string) => {
          if (!stopped && message.includes('backed up to')) { stopped = true; proc.emit('SIGINT'); lockFilesWhenStopped = readdirSync(lockDir); }
        },
      });
      expect(proc.exits).toEqual([130]);
      expect(lockFilesWhenStopped).toEqual([]); // freed by the stop itself, not by the normal flow that came after it in this fake
      expect(KEYS.map(dumpOf)).toEqual(before);
    });

    it('a stop in the middle of a run over two keys, one of which cannot be restored: the good one is back and unlocked, the bad one keeps its lock, exit 3', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      set(SCRATCH_KEY_2, 'two original');
      const before = KEYS.map(dumpOf);
      const lockDir = tmp();
      const proc = fakeProc();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let changed: () => void = () => undefined;
      const hasChanged = new Promise<void>((resolve) => { changed = resolve; });
      const run = withRegistryGuard(KEYS, async () => { changeBoth(); changed(); await gate; }, { backupDir: tmp(), lockDir, ...quiet, proc, afterBackup: tamper(0) });
      await hasChanged;
      proc.emit('SIGINT');
      // Synchronous, as for a process that is about to exit:
      expect(dumpOf(SCRATCH_KEY_2)).toBe(before[1]);
      expect(readdirSync(lockDir)).toEqual([LOCK_1]);
      expect(proc.exits).toEqual([VERIFY_FAILED_EXIT_CODE]);
      release();
      await expect(run).rejects.toThrow(/restore failed/);
    });

    it('the error names EVERY key that failed, with its own message, and says which diff lines belong to which key', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      set(SCRATCH_KEY_2, 'two original');
      const err = await withRegistryGuard(KEYS, changeBoth, {
        backupDir: tmp(), lockDir: tmp(), ...quiet, afterBackup: (saved: { file: string }[]) => { tamper(0)(saved); tamper(1)(saved); },
      }).then(() => undefined, (e: unknown) => e as { message: string; diff: string[]; diffByKey: Record<string, string[]> });
      expect(err).toBeDefined();
      for (const key of KEYS) {
        expect(err!.message).toContain(key);
        expect(err!.diffByKey[key]!.some((line) => line.includes('TAMPERED'))).toBe(true);
      }
      expect(err!.diff.length).toBe(KEYS.reduce((n, key) => n + err!.diffByKey[key]!.length, 0));
    });

    it('an empty lock file (a run cut off while it created it) is refused with a message that says it is unreadable, and leaves everything alone', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      const before = dumpOf(SCRATCH_KEY);
      const lockDir = tmp();
      writeFileSync(join(lockDir, LOCK_1), '');
      let ran = false;
      const err = await withRegistryGuard([SCRATCH_KEY], () => { ran = true; }, { backupDir: tmp(), lockDir, ...quiet }).then(() => undefined, (e: unknown) => e as { exitCode: number; message: string });
      expect(ran).toBe(false);
      expect(err?.exitCode).toBe(VERIFY_FAILED_EXIT_CODE);
      expect(err?.message).toContain('empty or unreadable');
      expect(existsSync(join(lockDir, LOCK_1))).toBe(true);
      expect(dumpOf(SCRATCH_KEY)).toBe(before);
    });

    it('a lock whose pid is alive (it may be a reused pid of a dead run) still says where the backup is and how to restore it', async () => {
      deleteBoth();
      set(SCRATCH_KEY, 'one original');
      const lockDir = tmp();
      const backupFile = join(tmp(), 'backup-0.reg');
      writeFileSync(join(lockDir, LOCK_1), JSON.stringify({ key: SCRATCH_KEY, pid: process.pid, startedAt: '2026-11-01T00:00:00.000Z', backupDir: join(backupFile, '..'), backups: [{ file: backupFile, existedBefore: true }] }));
      const err = await withRegistryGuard([SCRATCH_KEY], () => undefined, { backupDir: tmp(), lockDir, ...quiet }).then(() => undefined, (e: unknown) => e as { message: string });
      expect(err?.message).toContain('in progress');
      expect(err?.message).toContain('reused by an unrelated program');
      expect(err?.message).toContain(`reg import "${backupFile}"`);
      expect(err?.message).toContain(`reg delete "${SCRATCH_KEY}" /f`);
    });

    it('control: both locks have their own file name (the key name is part of it)', () => {
      expect(LOCK_1).not.toBe(LOCK_2);
      expect(LOCK_2.startsWith(LOCK_1.replace(/\.lock$/, ''))).toBe(true);
    });
  });
});
