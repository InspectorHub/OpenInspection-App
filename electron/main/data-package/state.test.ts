import { describe, expect, it } from 'vitest';
import {
  createDataPackageStateHost,
  type JobCheckpoint,
  type StateFs,
} from './state';

const FILE = 'D:/data/data-package-state.json';

function memFs(initial?: string): StateFs & { files: Map<string, Buffer>; links: Set<string> } {
  const files = new Map<string, Buffer>();
  const links = new Set<string>();
  if (initial !== undefined) files.set(FILE, Buffer.from(initial, 'utf8'));
  return {
    files,
    links,
    async mkdir() {},
    async lstat(path) { return { isSymbolicLink: () => links.has(path) }; },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async writeFile(path, data, options) {
      if (options?.flag === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, Buffer.from(data));
    },
    async rename(oldPath, newPath) {
      const value = files.get(oldPath);
      if (value === undefined) throw new Error('missing');
      files.delete(oldPath);
      files.set(newPath, value);
    },
    async unlink(path) { files.delete(path); },
  };
}

const checkpoint = (overrides: Partial<JobCheckpoint> = {}): JobCheckpoint => ({
  jobId: 'job-abc_123',
  kind: 'export',
  deviceLabel: 'DESKTOP-1',
  snapshotAt: 1_700_000_000_000,
  stage: 'rows',
  tables: { inspections: { cursor: 'eyJpZCI6MX0', rows: 10, bytes: 2048, shards: [], shardRows: [] } },
  counts: { rows: 10, media: 0 },
  bytes: 2048,
  meta: { schemaFingerprint: 'a'.repeat(64), serverVersion: '2.6.0' },
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe('data-package state: checkpoint persistence', () => {
  it('returns null when no state file exists', async () => {
    expect(await createDataPackageStateHost({ fs: memFs(), file: FILE, now: () => 1 }).load()).toBeNull();
  });

  it('round-trips a checkpoint and never writes the job token', async () => {
    const fs = memFs();
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 1_700_000_005_000 });
    await host.save(checkpoint());
    const loaded = await host.load();
    expect(loaded).toEqual(checkpoint({ updatedAt: 1_700_000_005_000 }));
    const raw = fs.files.get(FILE)!.toString('utf8');
    expect(raw).not.toMatch(/token|secret/i);
    expect(raw).not.toContain('Bearer');
  });

  it('never persists a token smuggled through an extra field or a hidden toJSON', async () => {
    const fs = memFs();
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 9 });
    // An extra enumerable field is rejected outright.
    await expect(host.save({ ...checkpoint(), jobToken: 'SECRET' } as never)).rejects.toThrow(/unreadable/);
    // A non-enumerable toJSON getter is invisible to Object.keys during validation;
    // writing the re-parsed clean object must still keep its injected token out.
    const sneaky = { ...checkpoint() } as JobCheckpoint & { toJSON(): unknown };
    Object.defineProperty(sneaky, 'toJSON', {
      enumerable: false,
      value: () => ({ ...checkpoint(), jobToken: 'TOKENSECRET' }),
    });
    await host.save(sneaky);
    expect(fs.files.get(FILE)!.toString('utf8')).not.toContain('TOKENSECRET');
    expect(fs.files.get(FILE)!.toString('utf8')).not.toContain('jobToken');
  });

  it('cleans up its temp file after a successful save', async () => {
    const fs = memFs();
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 2 });
    await host.save(checkpoint());
    // No leftover temp files after a successful save.
    expect([...fs.files.keys()]).toEqual([FILE]);
  });

  it('serializes concurrent saves', async () => {
    const fs = memFs();
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 3 });
    await Promise.all([
      host.save(checkpoint({ stage: 'rows' })),
      host.save(checkpoint({ stage: 'media' })),
    ]);
    expect((await host.load())?.stage).toBe('media');
  });

  it('refuses a symlinked state file', async () => {
    const fs = memFs();
    fs.links.add(FILE);
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 1 });
    await expect(host.load()).rejects.toThrow(/symlink/);
    await expect(host.save(checkpoint())).rejects.toThrow(/symlink/);
  });

  it('rejects a corrupt or schema-invalid state file instead of silently dropping it', async () => {
    for (const bad of [
      'not json',
      JSON.stringify({ jobId: 'x' }),
      JSON.stringify(checkpoint({ stage: 'bogus' as never })),
      JSON.stringify(checkpoint({ tables: { t: { cursor: 'x'.repeat(5000), rows: 1, bytes: 1, shards: [], shardRows: [] } } })),
      JSON.stringify(checkpoint({ counts: { rows: -1, media: 0 } })),
      JSON.stringify({ ...checkpoint(), extra: 'secret' }),
    ]) {
      await expect(createDataPackageStateHost({ fs: memFs(bad), file: FILE, now: () => 1 }).load()).rejects.toThrow(/unreadable/);
    }
  });

  it('clear removes the state file', async () => {
    const fs = memFs();
    const host = createDataPackageStateHost({ fs, file: FILE, now: () => 1 });
    await host.save(checkpoint());
    await host.clear();
    expect(fs.files.has(FILE)).toBe(false);
    expect(await host.load()).toBeNull();
  });
});
