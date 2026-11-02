import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { APP_KEY, SCRATCH_KEY, VERIFY_FAILED_EXIT_CODE, keyExists, withRegistryGuard } from './registry-guard.mjs';

// These tests touch ONLY the scratch key. The real io.inspectorhub.app key is never read, written or exported.
const reg = (...args: string[]) => execFileSync('reg.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
const addValue = (subkey: string, name: string, data: string) => reg('add', subkey === '' ? SCRATCH_KEY : `${SCRATCH_KEY}\\${subkey}`, '/v', name, '/t', 'REG_SZ', '/d', data, '/f');
const dump = (): string => reg('query', SCRATCH_KEY, '/s');
const deleteScratch = () => { try { reg('delete', SCRATCH_KEY, '/f'); } catch { /* absent */ } };

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'oi-registry-guard-test-')); dirs.push(d); return d; };
const quiet = { log: () => undefined };

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
    }, { backupDir: tmp(), ...quiet })).rejects.toBe(boom);
    expect(dump()).toBe(before);
  });

  it('deletes a key that did not exist before and the guarded function created', async () => {
    deleteScratch();
    expect(keyExists(SCRATCH_KEY)).toBe(false);
    const result = await withRegistryGuard([SCRATCH_KEY], () => { addValue('shell', 'Made', 'by the run'); return 'ok'; }, { backupDir: tmp(), ...quiet });
    expect(result).toBe('ok');
    expect(keyExists(SCRATCH_KEY)).toBe(false);
  });

  it('fails loudly with exit code 3 and the differing lines when the restore does not match the backup', async () => {
    deleteScratch();
    addValue('', 'Probe', 'original value');
    const err = await withRegistryGuard([SCRATCH_KEY], () => undefined, {
      backupDir: tmp(),
      ...quiet,
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
      await expect(withRegistryGuard([SCRATCH_KEY, key], () => { ran = true; }, { backupDir: tmp(), ...quiet })).rejects.toThrow(/allow-list/);
    }
    expect(ran).toBe(false);
    expect(keyExists(SCRATCH_KEY)).toBe(false);
    expect(APP_KEY).toBe('HKCU\\Software\\Classes\\io.inspectorhub.app');
  });
});
