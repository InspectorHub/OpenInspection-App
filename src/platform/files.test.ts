import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';
import { assertSafeRelativePath, createFiles, type FilesystemLike, WRITE_SLICE_BYTES } from './files';

function fakeFs() {
  const store = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const dirs = new Set<string>();
  const fs: FilesystemLike = {
    writeFile: ({ path, data, directory, recursive }) => {
      calls.push(`write:${path}`);
      dirs.add(directory);
      expect(recursive).toBe(true);
      store.set(path, base64ToBytes(data));
      return Promise.resolve({ uri: `file:///data/${path}` });
    },
    appendFile: ({ path, data, directory }) => {
      calls.push(`append:${path}`);
      dirs.add(directory);
      const prev = store.get(path);
      if (!prev) return Promise.reject(new Error('append to missing file'));
      const add = base64ToBytes(data);
      const next = new Uint8Array(prev.length + add.length);
      next.set(prev);
      next.set(add, prev.length);
      store.set(path, next);
      return Promise.resolve();
    },
    readFile: ({ path }) => {
      const bytes = store.get(path);
      if (!bytes) return Promise.reject(new Error('missing'));
      return Promise.resolve({ data: bytesToBase64(bytes) });
    },
    deleteFile: ({ path }) => {
      calls.push(`delete:${path}`);
      store.delete(path);
      return Promise.resolve();
    },
    getUri: ({ path }) => Promise.resolve({ uri: `file:///data/${path}` }),
  };
  return { fs, store, calls, dirs };
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.compare(a, b) === 0;

const make = () => {
  const f = fakeFs();
  return { ...f, files: createFiles({ fs: f.fs, convertFileSrc: (u) => `https://localhost/_capacitor_file_${u.slice(7)}` }) };
};

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes, including large inputs', () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    expect(sameBytes(base64ToBytes(bytesToBase64(bytes)), bytes)).toBe(true);
  });
});

describe('Files path handling', () => {
  it('accepts ordinary relative paths (positive control)', async () => {
    const { files, store } = make();
    expect(() => assertSafeRelativePath('photos/abc/1.jpg')).not.toThrow();
    const uri = await files.write('photos/abc/1.jpg', Uint8Array.from([1, 2, 3]));
    expect(uri).toBe('file:///data/photos/abc/1.jpg');
    expect(store.get('photos/abc/1.jpg')).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it.each(['../secret', 'a/../../b', '/etc/passwd', 'C:/x', 'file:///x', 'a\\b', 'a//b', '', '.', 'a/./b', 'a/\u0000b'])(
    'rejects %j on every operation and touches nothing',
    async (bad) => {
      const { files, calls } = make();
      await expect(files.write(bad, Uint8Array.from([1]))).rejects.toThrow(/path/i);
      await expect(files.read(bad)).rejects.toThrow(/path/i);
      await expect(files.remove(bad)).rejects.toThrow(/path/i);
      await expect(files.displayUrl(bad)).rejects.toThrow(/path/i);
      await expect(files.writeCacheChunks(bad, (async function* () { yield Uint8Array.from([1]); })())).rejects.toThrow(/path/i);
      expect(calls).toEqual([]);
    },
  );
});

describe('Files I/O', () => {
  it('uses the no-backup library directory', async () => {
    const { files, dirs } = make();
    await files.write('a.bin', Uint8Array.from([1]));
    expect([...dirs]).toEqual(['LIBRARY_NO_CLOUD']);
  });

  it('reads back exactly what was written', async () => {
    const { files } = make();
    const bytes = Uint8Array.from([0, 255, 128, 7]);
    await files.write('x/y.bin', bytes);
    expect(await files.read('x/y.bin')).toEqual(bytes);
  });

  it('splits a large write into one write plus appends and keeps the bytes intact', async () => {
    const { files, calls, store } = make();
    const bytes = new Uint8Array(WRITE_SLICE_BYTES * 2 + 10);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    await files.write('big.bin', bytes);
    expect(calls).toEqual(['write:big.bin', 'append:big.bin', 'append:big.bin']);
    expect(sameBytes(store.get('big.bin'), bytes)).toBe(true);
  });

  it('writes an empty file for empty data', async () => {
    const { files, store } = make();
    await files.write('empty.bin', new Uint8Array(0));
    expect(store.get('empty.bin')).toEqual(new Uint8Array(0));
  });

  it('streams chunks into one file', async () => {
    const { files, store, calls } = make();
    async function* gen() {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3]);
      yield Uint8Array.from([4, 5]);
    }
    const uri = await files.writeCacheChunks('cache/v.mp4', gen());
    expect(uri).toBe('file:///data/cache/v.mp4');
    expect(store.get('cache/v.mp4')).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(calls).toEqual(['write:cache/v.mp4', 'append:cache/v.mp4', 'append:cache/v.mp4']);
  });

  it('removes the partial file when the stream fails midway', async () => {
    const { files, store } = make();
    async function* gen() {
      yield Uint8Array.from([1]);
      throw new Error('network dropped');
    }
    await expect(files.writeCacheChunks('cache/v.mp4', gen())).rejects.toThrow('network dropped');
    expect(store.has('cache/v.mp4')).toBe(false);
  });

  it('removes files and builds display urls through convertFileSrc', async () => {
    const { files, store } = make();
    await files.write('p.jpg', Uint8Array.from([1]));
    expect(await files.displayUrl('p.jpg')).toBe('https://localhost/_capacitor_file_/data/p.jpg');
    await files.remove('p.jpg');
    expect(store.has('p.jpg')).toBe(false);
  });
});
