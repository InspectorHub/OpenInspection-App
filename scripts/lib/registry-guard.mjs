// Back up, restore and verify a Windows registry key around code that is known to change it.
//
// Why this exists: launching the packaged Windows app always calls app.setAsDefaultProtocolClient, which rewrites
// HKCU\Software\Classes\io.inspectorhub.app\shell\open\command of the machine's REAL installed app to point at the exe
// that was run, and nothing restores it. A smoke test of an unpacked build must therefore put the key back.
//
// Everything goes through reg.exe with execFileSync (an argument vector, never a shell string), and only keys on an
// explicit allow-list are accepted. Windows only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const APP_KEY = 'HKCU\\Software\\Classes\\io.inspectorhub.app';
export const SCRATCH_KEY = 'HKCU\\Software\\Classes\\io.inspectorhub.smoke-scratch';
const ALLOWED = new Set([APP_KEY.toLowerCase(), SCRATCH_KEY.toLowerCase()]);

export const VERIFY_FAILED_EXIT_CODE = 3;

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

function reg(args) {
  return execFileSync('reg.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export function keyExists(key) {
  assertAllowedKey(key);
  try {
    reg(['query', key]);
    return true;
  } catch (error) {
    // reg query exits 1 for a missing key; anything else (reg.exe missing, access denied) must not read as "absent".
    if (error?.status === 1) return false;
    throw error;
  }
}

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
  if (existedBefore) reg(['import', file]);
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

// afterBackup is a test seam (it lets a test tamper with the backup files to prove a bad restore is caught).
export async function withRegistryGuard(keys, fn, { backupDir, afterBackup, log = (m) => console.log(m) } = {}) {
  for (const key of keys) assertAllowedKey(key);
  const dir = backupDir ?? mkdtempSync(join(tmpdir(), 'oi-registry-guard-'));
  mkdirSync(dir, { recursive: true });
  const saved = keys.map((key, i) => {
    const existedBefore = keyExists(key);
    const file = join(dir, `backup-${String(i)}.reg`);
    let expected;
    if (existedBefore) {
      exportKey(key, file);
      expected = readFileSync(file);
    }
    log(`registry guard: ${key} ${existedBefore ? `backed up to ${file}` : 'does not exist (it will be deleted again afterwards)'}`);
    return { key, file, existedBefore, expected };
  });
  afterBackup?.(saved);
  let failure;
  let result;
  try {
    result = await fn();
  } catch (error) {
    failure = error;
  }
  const problems = [];
  for (const { key, file, existedBefore, expected } of saved) {
    try {
      restoreKey(key, file, existedBefore);
      verifyRestored(key, file, existedBefore, expected);
      log(`registry guard: ${key} restored and verified identical`);
    } catch (error) {
      problems.push(error);
      process.stderr.write(`REGISTRY GUARD: restoring ${key} FAILED: ${error.message}\n${(error.diff ?? []).join('\n')}\nBackup: ${file}\n`);
    }
  }
  if (problems.length > 0) {
    const first = problems[0];
    throw new RegistryGuardError(`registry restore failed (${first.message})${failure ? `; the guarded run also failed: ${failure.message}` : ''}`, {
      exitCode: VERIFY_FAILED_EXIT_CODE,
      diff: problems.flatMap((p) => p.diff ?? []),
    });
  }
  if (failure) throw failure;
  return result;
}
