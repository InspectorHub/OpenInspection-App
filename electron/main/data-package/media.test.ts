import { describe, expect, it } from 'vitest';
import { downloadMedia, listAllMedia, type MediaDeps } from './media';
import type { RunnerResponse } from './types';

function descriptor(over: Partial<import('./types').MediaDescriptor> = {}): import('./types').MediaDescriptor {
  return {
    key: 'inspections/i1/photos/a.jpg', size: 3, etag: 'e', uploaded: 1,
    contentType: 'image/jpeg', kind: 'image', ...over,
  };
}

function deps(over: Partial<MediaDeps> = {}): MediaDeps {
  return {
    json: async () => ({ status: 200, json: {}, text: '', budget: null } as RunnerResponse),
    bytes: async () => ({ status: 200, bytes: new Uint8Array([1, 2, 3]) }),
    mediaUrl: (cursor) => `https://x/api/media?cursor=${cursor ?? ''}`,
    objectUrl: (key) => `https://x/api/media/object?key=${key}`,
    headers: () => ({ 'X-Data-Job': 'j' }),
    ...over,
  };
}

const listPage = (objects: unknown[], cursor: string | null, truncated: boolean): RunnerResponse => ({
  status: 200,
  json: { success: true, data: { objects, cursor, truncated } },
  text: '', budget: null,
});

describe('listAllMedia', () => {
  it('follows the cursor across pages and validates descriptors', async () => {
    const d = deps({
      json: async (req) => {
        const cursor = new URL(req.url).searchParams.get('cursor');
        if (cursor === '') return listPage([descriptor({ key: 'a.jpg' })], 'c1', true);
        if (cursor === 'c1') return listPage([descriptor({ key: 'b.jpg' })], null, false);
        throw new Error('bad cursor');
      },
    });
    const all = await listAllMedia(d);
    expect(all.map((m) => m.key)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('rejects a truncated page with no cursor', async () => {
    const d = deps({ json: async () => listPage([], null, true) });
    await expect(listAllMedia(d)).rejects.toThrow('media-cursor-missing');
  });

  it('rejects an unsafe descriptor', async () => {
    const d = deps({ json: async () => listPage([{ key: 42, size: 1 }], null, false) });
    await expect(listAllMedia(d)).rejects.toThrow('media-object');
  });
});

describe('downloadMedia', () => {
  it('downloads, hashes and volume-plans good objects', async () => {
    const d = deps();
    const result = await downloadMedia(d, [descriptor()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.excluded).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toMatch(/^media-\d+\.zip$/);
  });

  it('excludes an object whose bytes do not match the declared size, and continues', async () => {
    const d = deps({ bytes: async () => ({ status: 200, bytes: new Uint8Array([9, 9]) }) });
    const result = await downloadMedia(d, [descriptor({ key: 'bad.jpg', size: 3 }), descriptor({ key: 'good.jpg', size: 3 })]);
    // Both use the same fake bytes; the first has size 3 but gets 2 -> mismatch.
    expect(result.excluded.some((e) => e.class === 'bad_media')).toBe(true);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it('retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const d = deps({
      bytes: async () => {
        attempts++;
        if (attempts < 3) throw new Error('network');
        return { status: 200, bytes: new Uint8Array([1, 2, 3]) };
      },
    });
    const result = await downloadMedia(d, [descriptor()]);
    expect(attempts).toBe(3);
    expect(result.rows).toHaveLength(1);
    expect(result.failed).toBe(0);
  });

  it('excludes a permanently failing object after MAX_RETRIES+1 attempts', async () => {
    let attempts = 0;
    const d = deps({ bytes: async () => { attempts++; throw new Error('down'); } });
    const result = await downloadMedia(d, [descriptor({ key: 'doomed.jpg' })]);
    expect(attempts).toBe(4);
    expect(result.excluded).toHaveLength(1);
    expect(result.failed).toBe(1);
  });

  it('excludes an oversize object without downloading it', async () => {
    let calls = 0;
    const d = deps({ bytes: async () => { calls++; return { status: 200, bytes: new Uint8Array(0) }; } });
    const result = await downloadMedia(d, [descriptor({ key: 'huge.mp4', size: 600 * 1024 * 1024 })]);
    expect(calls).toBe(0);
    expect(result.excluded.some((e) => e.class === 'oversize_media')).toBe(true);
  });
});
