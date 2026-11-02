// Back up, restore and verify a Windows registry key around code that is known to change it.
//
// Why this exists: launching the packaged Windows app always calls app.setAsDefaultProtocolClient, which rewrites
// HKCU\Software\Classes\io.inspectorhub.app\shell\open\command of the machine's REAL installed app to point at the exe
// that was run, and nothing restores it. A smoke test of an unpacked build must therefore put the key back.
//
// Everything goes through reg.exe with execFileSync (an argument vector, never a shell string), and only keys on an
// explicit allow-list are accepted. Windows only.
//
// What the guarantee covers, and what it does not:
//  - the guarded function returns, throws, or rejects: the key is restored and verified in the normal flow;
//  - Ctrl+C, a terminal closed, SIGTERM, an uncaught exception, process.exit() somewhere else: the same synchronous restore runs
//    from a signal or `exit` handler (execFileSync works there), and the guarded run's child processes are stopped first;
//  - the process is killed outright (taskkill /F, power loss): nothing can run. The next run then finds the lock file this one left
//    behind and REFUSES to start, naming the backup and the two commands that restore it, so the modified state is never taken for
//    the original and backed up over it. The lock is removed only after a verified restore.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const APP_KEY = 'HKCU\\Software\\Classes\\io.inspectorhub.app';
export const SCRATCH_KEY = 'HKCU\\Software\\Classes\\io.inspectorhub.smoke-scratch';
// A second test-only key: it lets the tests guard SEVERAL keys in one run (one of them failing to restore) without touching the real one.
export const SCRATCH_KEY_2 = 'HKCU\\Software\\Classes\\io.inspectorhub.smoke-scratch-two';
const ALLOWED = new Set([APP_KEY.toLowerCase(), SCRATCH_KEY.toLowerCase(), SCRATCH_KEY_2.toLowerCase()]);

export const VERIFY_FAILED_EXIT_CODE = 3;
export const ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

export class RegistryGuardError extends Error {
  constructor(message, { exitCode = 1, diff = [] } = {}) {
    super(message);
    this.name = 'RegistryGuardError';
    this.exitCode = exitCode;
    this.diff = diff;
  }
}

export function assertAllowedKey(key) {
  if (typeof key !== 'string' || !ALLOWED.has(key.toLowerCase())) {
    throw new RegistryGuardError(`registry key not on the allow-list: ${String(key)}`);
  }
}

// An absolute path: on Windows a bare name is also looked up in the current directory, and a planted reg.exe there would run.
export const REG_EXE = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'reg.exe');

function reg(args) {
  return execFileSync(REG_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** keyExists with the query function given, so a test can say what reg.exe would have answered. */
export function keyExistsWith(query, key) {
  assertAllowedKey(key);
  try {
    query(['query', key]);
    return true;
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  // reg query exits 1 for a missing key, but also for some access-denied and policy errors. "Absent" decides that the restore DELETES the
  // key, so it is only believed when the parent key can be read: a missing key under a readable parent is missing.
  const parent = key.slice(0, key.lastIndexOf('\\'));
  try {
    query(['query', parent, '/ve']);
  } catch (error) {
    throw new RegistryGuardError(`cannot read ${parent}, so ${key} is not assumed to be absent: ${String(error?.message ?? error)}`);
  }
  return false;
}

export const keyExists = (key) => keyExistsWith(reg, key);

export function exportKey(key, file) {
  assertAllowedKey(key);
  reg(['export', key, file, '/y']);
  if (!existsSync(file) || statSync(file).size === 0) throw new RegistryGuardError(`reg export wrote an empty file for ${key}: ${file}`);
}

// reg.exe writes UTF-16LE with a BOM. The first line is a version header and is the only line that is ignored.
function normalise(buffer) {
  const text = buffer.toString('utf16le').replace(/^﻿/, '');
  return text.split(/\r?\n/).slice(1).filter((line) => line.trim() !== '');
}

function diffLines(expected, actual) {
  const out = [];
  const exp = new Set(expected);
  const act = new Set(actual);
  for (const line of expected) if (!act.has(line)) out.push(`- ${line}`);
  for (const line of actual) if (!exp.has(line)) out.push(`+ ${line}`);
  if (out.length === 0 && expected.join('\n') !== actual.join('\n')) out.push('(same lines, different order or repetition)');
  return out;
}

export function restoreKey(key, file, existedBefore) {
  assertAllowedKey(key);
  if (keyExists(key)) reg(['delete', key, '/f']);
  if (!existedBefore) return;
  try {
    reg(['import', file]);
  } catch {
    // The key is gone at this point, so one more try is cheap insurance (a transient lock on the hive); a second failure is loud.
    reg(['import', file]);
  }
}

// expectedBuffer defaults to the backup file; withRegistryGuard passes the bytes it read at backup time, so a backup
// file that was altered afterwards cannot make a wrong restore look right.
export function verifyRestored(key, file, existedBefore = true, expectedBuffer = existedBefore ? readFileSync(file) : undefined) {
  assertAllowedKey(key);
  if (!existedBefore) {
    if (keyExists(key)) throw new RegistryGuardError(`${key} existed after restore but did not exist before`, { exitCode: VERIFY_FAILED_EXIT_CODE, diff: ['+ (key present)'] });
    return;
  }
  const check = `${file}.verify.reg`;
  exportKey(key, check);
  const diff = diffLines(normalise(expectedBuffer), normalise(readFileSync(check)));
  if (diff.length > 0) throw new RegistryGuardError(`${key} differs from its backup after restore`, { exitCode: VERIFY_FAILED_EXIT_CODE, diff });
}

/**
 * Whether an open command points at a build or temp path: the leftover of an earlier smoke run, or of starting the packaged exe by hand.
 * Backing such a key up would take the modified state for the original, so the smoke script refuses to start on it.
 */
export function looksLikeLeftover(command, tmp = tmpdir()) {
  if (typeof command !== 'string') return false;
  if (/win-unpacked|oi-win-smoke|[\\/]tmp[\\/]/i.test(command)) return true;
  // Under this machine's own temp directory, whatever it is called here (a profile folder named Temp elsewhere is not it).
  const slashes = (text) => String(text).replace(/\//g, '\\').toLowerCase();
  const root = slashes(tmp).replace(/\\+$/, '');
  return root !== '' && slashes(command).includes(`${root}\\`);
}

/** The commands that put a key back by hand from its backup file (printed whenever a backup is taken). */
export function manualRestoreCommand(key, file, existedBefore) {
  return existedBefore ? `reg delete "${key}" /f\n  reg import "${file}"` : `reg delete "${key}" /f`;
}

// ---- the lock: one guarded run per key, and a run that died leaves proof of it behind -------------------------------------------

/**
 * Where the locks live: a fixed per-user directory, NOT the temp directory. A temp directory follows TEMP/TMP (which differ between shells and
 * sandboxes) and is emptied by cleaners, and the lock is the only thing that stops a run from backing up a key a killed run left modified.
 */
export function defaultLockDir(env = process.env) {
  return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'InspectorHub', 'registry-guard');
}

function lockPathFor(lockDir, key) {
  return join(lockDir, `oi-registry-guard-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.lock`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireLock(path, info) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, 'wx');
    try { writeSync(fd, JSON.stringify(info)); } finally { closeSync(fd); }
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let held = {};
  try { held = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: treated like a lock of a dead run */ }
  if (!Number.isInteger(held.pid)) {
    throw new RegistryGuardError(
      `the lock file ${path} is empty or unreadable (a run was cut off while it was creating it), so nothing says whether ${info.key} was modified or where a backup is. `
      + 'Look at the key; if it is wrong, restore it from a backup you trust. Then delete the lock file and run again.',
      { exitCode: VERIFY_FAILED_EXIT_CODE },
    );
  }
  const how = (held.backups ?? []).map((b) => manualRestoreCommand(held.key ?? info.key, b.file, b.existedBefore)).join('\n  ');
  if (pidAlive(held.pid)) {
    // A process id can be reused by an unrelated program, so this may be a dead run that left the key modified: say how to restore it too.
    throw new RegistryGuardError(
      `another guarded run of ${info.key} seems to be in progress (pid ${String(held.pid)}, started ${String(held.startedAt)}; lock file ${path}). `
      + `If no such run is going (a process id can be reused by an unrelated program), the run that left this lock died and ${info.key} may still be modified: its backup is in ${String(held.backupDir)}${how === '' ? '' : `. To restore it by hand:\n  ${how}`}\n`
      + 'then delete the lock file and run again.',
    );
  }
  throw new RegistryGuardError(
    `a previous guarded run of ${info.key} (pid ${String(held.pid)}, started ${String(held.startedAt)}) ended WITHOUT a verified restore, so the key may still be modified `
    + `and is NOT backed up again. Its backup is in ${String(held.backupDir)}. Restore it by hand${how === '' ? '' : `:\n  ${how}`}\nthen delete ${path} and run again.`,
    { exitCode: VERIFY_FAILED_EXIT_CODE },
  );
}

const writeLock = (path, info) => { try { writeFileSync(path, JSON.stringify(info)); } catch { /* the lock exists already; only its detail is lost */ } };
const releaseLock = (path) => { try { rmSync(path, { force: true }); } catch { /* nothing more to do */ } };

// ---- abort handling -----------------------------------------------------------------------------------------------------------------

/**
 * Runs `restore(why)` once if the process is told to stop or is exiting: on a signal it then exits (130 for Ctrl+C, 143 otherwise, 3 when
 * the restore found problems); on `exit` it only restores. `restore` must be synchronous and returns the number of problems.
 * Returns the function that removes the handlers (the normal flow calls it after its own restore).
 */
export function installAbortHandlers({ proc = process, restore }) {
  let ran = false;
  const run = (why) => {
    if (ran) return 0;
    ran = true;
    try { return restore(why); } catch { return 1; }
  };
  const handlers = ABORT_SIGNALS.map((signal) => [signal, () => { const problems = run(signal); proc.exit(problems > 0 ? VERIFY_FAILED_EXIT_CODE : signal === 'SIGINT' ? 130 : 143); }]);
  // A restore that failed here (the watchdog's process.exit(1), a process.exit(0) somewhere) must not exit 0 or 1: the key may be modified.
  const onExit = () => { if (run('exit') > 0) proc.exitCode = VERIFY_FAILED_EXIT_CODE; };
  for (const [signal, handler] of handlers) proc.on(signal, handler);
  proc.on('exit', onExit);
  return () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
    proc.off('exit', onExit);
  };
}

/** Restores and verifies every key, one at a time. Returns one { ok, error } per key, in the order of `saved`; a failure never stops the others. */
function restoreAll(saved, log) {
  return saved.map(({ key, file, existedBefore, expected }) => {
    try {
      restoreKey(key, file, existedBefore);
      verifyRestored(key, file, existedBefore, expected);
      log(`registry guard: ${key} restored and verified identical`);
      return { ok: true };
    } catch (error) {
      process.stderr.write(`REGISTRY GUARD: restoring ${key} FAILED: ${error.message}\n${(error.diff ?? []).join('\n')}\nBackup: ${file}\nBy hand: ${manualRestoreCommand(key, file, existedBefore)}\n`);
      return { ok: false, error };
    }
  });
}

/**
 * Runs `fn` with the keys backed up, then puts them back and verifies it.
 * Options: backupDir (a directory that holds no backup from an earlier run), log, onAbort (synchronous; stops what the guarded run
 * started, called before the restore of an abort), lockDir, env, proc (seams for tests), afterBackup (a test seam that lets a test
 * tamper with the backup files to prove a bad restore is caught).
 */
export async function withRegistryGuard(keys, fn, { backupDir, afterBackup, onAbort, log = (m) => console.log(m), env = process.env, lockDir = defaultLockDir(env), proc = process } = {}) {
  for (const key of keys) assertAllowedKey(key);
  const lowered = keys.map((key) => key.toLowerCase());
  if (new Set(lowered).size !== lowered.length) throw new RegistryGuardError(`a key is listed twice (keys are compared without regard to case): ${keys.join(', ')}`);
  if (keys.some((key) => key.toLowerCase() === APP_KEY.toLowerCase()) && (env.CI !== undefined || env.GITHUB_ACTIONS !== undefined)) {
    throw new RegistryGuardError(`refusing to touch ${APP_KEY} in CI: this is a manual test of a machine's real app registration`);
  }
  const dir = backupDir ?? mkdtempSync(join(tmpdir(), 'oi-registry-guard-'));
  if (existsSync(dir) && readdirSync(dir).some((name) => /^backup-\d+\.reg/.test(name))) {
    throw new RegistryGuardError(`${dir} already holds a backup from an earlier run; it may be the only copy of the original. Look at it, then use a new directory.`);
  }

  const locks = [];
  const saved = [];
  // True from the moment the guarded function may have changed a key. Until then an abort has nothing to restore, only locks to free.
  let started = false;
  const releaseAll = () => { for (const path of locks) releaseLock(path); };
  // A key whose restore did not verify keeps its lock (the next run on THAT key must refuse); the keys that did verify are free again.
  const releaseVerified = (results) => { results.forEach((r, i) => { if (r.ok) releaseLock(locks[i]); }); };
  // Installed BEFORE the first lock: a Ctrl+C during the backups must not leave a lock behind that makes the next run refuse for a key
  // nothing ever changed.
  const uninstall = installAbortHandlers({
    proc,
    restore: (why) => {
      if (!started) {
        log(`registry guard: ${why} before the run started: no key was changed, releasing the locks`);
        releaseAll();
        return 0;
      }
      log(`registry guard: ${why}: stopping what the run started and restoring before exit`);
      try { onAbort?.(); } catch { /* the restore matters more than the cleanup */ }
      const results = restoreAll(saved, log);
      releaseVerified(results);
      return results.filter((r) => !r.ok).length;
    },
  });
  try {
    for (const key of keys) {
      const path = lockPathFor(lockDir, key);
      acquireLock(path, { key, pid: process.pid, startedAt: new Date().toISOString(), backupDir: dir, backups: [] });
      locks.push(path);
    }
    mkdirSync(dir, { recursive: true });
    keys.forEach((key, i) => {
      const existedBefore = keyExists(key);
      const file = join(dir, `backup-${String(i)}.reg`);
      let expected;
      if (existedBefore) {
        exportKey(key, file);
        expected = readFileSync(file);
      }
      saved.push({ key, file, existedBefore, expected });
      log(`registry guard: ${key} ${existedBefore ? `backed up to ${file}` : 'does not exist (it will be deleted again afterwards)'}`);
      log(`registry guard: if this run is ever killed outright, restore by hand with:\n  ${manualRestoreCommand(key, file, existedBefore)}`);
    });
    const startedAt = new Date().toISOString();
    saved.forEach(({ key, file, existedBefore }, i) => writeLock(locks[i], { key, pid: process.pid, startedAt, backupDir: dir, backups: [{ file, existedBefore }] }));
    afterBackup?.(saved);
  } catch (error) {
    // Nothing the guarded function does has run yet: the keys are as they were, so the locks go.
    uninstall();
    releaseAll();
    throw error;
  }
  started = true;
  let failure;
  let result;
  try {
    result = await fn();
  } catch (error) {
    failure = error;
  }
  const results = restoreAll(saved, log);
  uninstall();
  // A lock is only removed after a verified restore: a failed one must stop the next run from backing up a modified key as the original.
  releaseVerified(results);
  const failed = results.map((r, i) => ({ r, key: saved[i].key })).filter((x) => !x.r.ok);
  if (failed.length > 0) {
    // Every failed key is named, with its own message; `diff` is all their lines together and `diffByKey` says which line belongs to which key.
    const error = new RegistryGuardError(
      `registry restore failed for ${failed.map((f) => f.key).join(', ')} (${failed.map((f) => `${f.key}: ${f.r.error.message}`).join('; ')})${failure ? `; the guarded run also failed: ${failure.message}` : ''}`,
      { exitCode: VERIFY_FAILED_EXIT_CODE, diff: failed.flatMap((f) => f.r.error.diff ?? []) },
    );
    error.diffByKey = Object.fromEntries(failed.map((f) => [f.key, f.r.error.diff ?? []]));
    throw error;
  }
  if (failure) throw failure;
  return result;
}
