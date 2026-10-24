import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64';
import { assertSafeRelativePath, createFiles, type FilesystemLike, WRITE_SLICE_BYTES } from './files';

function fakeFs() {
  const store = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const dirs = new Set<string>();
  const dirLog: string[] = [];
  const fs: FilesystemLike = {
    writeFile: ({ path, data, directory, recursive }) => {
      calls.push(`write:${path}`);
      dirLog.push(`write:${directory}`);
      dirs.add(directory);
      expect(recursive).toBe(true);
      store.set(path, base64ToBytes(data));
      return Promise.resolve({ uri: `file:///data/${path}` });
    },
    appendFile: ({ path, data, directory }) => {
      calls.push(`append:${path}`);
      dirLog.push(`append:${directory}`);
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
    readFile: ({ path, directory }) => {
      dirLog.push(`read:${directory}`);
      const bytes = store.get(path);
      if (!bytes) return Promise.reject(new Error('missing'));
      return Promise.resolve({ data: bytesToBase64(bytes) });
    },
    deleteFile: ({ path, directory }) => {
      calls.push(`delete:${path}`);
      dirLog.push(`delete:${directory}`);
      store.delete(path);
      return Promise.resolve();
    },
    getUri: ({ path, directory }) => {
      dirLog.push(`uri:${directory}`);
      return Promise.resolve({ uri: `file:///data/${path}` });
    },
    stat: ({ path, directory }) => {
      dirLog.push(`stat:${directory}`);
      return store.has(path) ? Promise.resolve({ type: 'file', size: store.get(path)?.length ?? 0 }) : Promise.reject(new Error('File does not exist'));
    },
    readdir: ({ path, directory }) => {
      dirLog.push(`readdir:${directory}`);
      const prefix = `${path}/`;
      const names = [...store.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
      if (names.length === 0) return Promise.reject(new Error('Directory does not exist'));
      return Promise.resolve({ files: names.map((key, index) => (index === 0 ? { name: key.slice(prefix.length), mtime: 5_000 } : { name: key.slice(prefix.length) })) });
    },
  };
  return { fs, store, calls, dirs, dirLog };
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
      await expect(files.fileUri(bad)).rejects.toThrow(/path/i);
      await expect(files.exists(bad)).rejects.toThrow(/path/i);
      await expect(files.writeCacheChunks(bad, (async function* () { yield Uint8Array.from([1]); })())).rejects.toThrow(/path/i);
      expect(calls).toEqual([]);
    },
  );
});

describe('Files I/O', () => {
  it('uses the no-backup library directory for write, read and remove', async () => {
    const { files, dirs, dirLog } = make();
    await files.write('a.bin', Uint8Array.from([1]));
    await files.read('a.bin');
    await files.remove('a.bin');
    expect([...dirs]).toEqual(['LIBRARY_NO_CLOUD']);
    expect(dirLog).toEqual(['write:LIBRARY_NO_CLOUD', 'read:LIBRARY_NO_CLOUD', 'delete:LIBRARY_NO_CLOUD']);
  });

  it('streams cache chunks into the cache directory only, and removeCache deletes from it', async () => {
    const { files, dirLog } = make();
    async function* gen() {
      yield Uint8Array.from([1]);
      yield Uint8Array.from([2]);
    }
    await files.writeCacheChunks('export.zip', gen());
    await files.removeCache('export.zip');
    expect(dirLog).toEqual(['write:CACHE', 'append:CACHE', 'delete:CACHE']);
  });

  it('removeCache validates the path', async () => {
    const { files, calls } = make();
    await expect(files.removeCache('../x')).rejects.toThrow(/path/i);
    expect(calls).toEqual([]);
  });

  it('answers a native file uri and existence for the no-backup library directory only', async () => {
    const { files, dirLog } = make();
    await files.write('media/a.jpg', Uint8Array.from([1]));
    expect(await files.fileUri('media/a.jpg')).toBe('file:///data/media/a.jpg');
    expect(await files.exists('media/a.jpg')).toBe(true);
    expect(await files.exists('media/missing.jpg')).toBe(false);
    expect(dirLog).toEqual(['write:LIBRARY_NO_CLOUD', 'uri:LIBRARY_NO_CLOUD', 'stat:LIBRARY_NO_CLOUD', 'stat:LIBRARY_NO_CLOUD']);
  });

  it('exists: only a confirmed not-found answers false; any other stat error is thrown, never read as "gone"', async () => {
    const failWith = (error: unknown): ReturnType<typeof make> => {
      const f = make();
      f.fs.stat = () => Promise.reject(error);
      return { ...f, files: createFiles({ fs: f.fs, convertFileSrc: (u) => u }) };
    };
    const notFoundByMessage = failWith(new Error("'stat' failed because file at '/data/media/a.jpg' does not exist."));
    expect(await notFoundByMessage.files.exists('media/a.jpg')).toBe(false);
    const notFoundByCode = failWith(Object.assign(new Error('x'), { code: 'OS-PLUG-FILE-0008' }));
    expect(await notFoundByCode.files.exists('media/a.jpg')).toBe(false);
    const legacy = failWith(new Error('File does not exist'));
    expect(await legacy.files.exists('media/a.jpg')).toBe(false);

    await expect(failWith(new Error('I/O error')).files.exists('media/a.jpg')).rejects.toThrow('I/O error');
    await expect(failWith(Object.assign(new Error('denied'), { code: 'OS-PLUG-FILE-0007' })).files.exists('media/a.jpg')).rejects.toThrow('denied');
    await expect(failWith('not an error').files.exists('media/a.jpg')).rejects.toBeDefined();
  });

  it('list: names and modification times of the direct entries; a missing directory is empty; other failures are thrown', async () => {
    const { files, fs } = make();
    expect(await files.list('media')).toEqual([]);
    await files.write('media/a.jpg', Uint8Array.from([1]));
    await files.write('media/b.jpg', Uint8Array.from([1]));
    await files.write('other/c.jpg', Uint8Array.from([1]));
    expect(await files.list('media')).toEqual([
      { name: 'a.jpg', mtimeMs: 5_000 },
      { name: 'b.jpg', mtimeMs: null },
    ]);
    fs.readdir = () => Promise.reject(new Error('I/O error'));
    await expect(files.list('media')).rejects.toThrow('I/O error');
    await expect(files.list('../x')).rejects.toThrow(/path/i);
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

  it('keeps a pre-existing file when the stream throws before its first chunk', async () => {
    const { files, store } = make();
    store.set('cache/v.mp4', Uint8Array.from([9, 9]));
    async function* gen(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      throw new Error('failed early');
    }
    await expect(files.writeCacheChunks('cache/v.mp4', gen())).rejects.toThrow('failed early');
    expect(store.get('cache/v.mp4')).toEqual(Uint8Array.from([9, 9]));
  });

  it('removes what this call wrote when failing after the first chunk (control)', async () => {
    const { files, store } = make();
    store.set('cache/v.mp4', Uint8Array.from([9, 9]));
    async function* gen() {
      yield Uint8Array.from([1]);
      throw new Error('failed late');
    }
    await expect(files.writeCacheChunks('cache/v.mp4', gen())).rejects.toThrow('failed late');
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

describe('Files.writeStream and Files.size (video clips)', () => {
  it('writes a stream into the no-backup directory in order, without holding it whole, and answers the uri', async () => {
    const { files, store, dirLog, calls } = make();
    async function* gen() {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3]);
      yield Uint8Array.from([4, 5]);
    }
    expect(await files.writeStream('media/v.mp4', gen())).toBe('file:///data/media/v.mp4');
    expect(store.get('media/v.mp4')).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(calls).toEqual(['write:media/v.mp4', 'append:media/v.mp4', 'append:media/v.mp4']);
    expect([...new Set(dirLog)]).toEqual(['write:LIBRARY_NO_CLOUD', 'append:LIBRARY_NO_CLOUD']);
  });

  it('removes what it wrote when the stream fails after the first chunk, and keeps an older file when it fails before (control)', async () => {
    const { files, store } = make();
    store.set('media/v.mp4', Uint8Array.from([9]));
    async function* early(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      throw new Error('early');
    }
    await expect(files.writeStream('media/v.mp4', early())).rejects.toThrow('early');
    expect(store.get('media/v.mp4')).toEqual(Uint8Array.from([9]));
    async function* late() {
      yield Uint8Array.from([1]);
      throw new Error('late');
    }
    await expect(files.writeStream('media/v.mp4', late())).rejects.toThrow('late');
    expect(store.has('media/v.mp4')).toBe(false);
  });

  it('refuses an unsafe path before touching the stream or the disk', async () => {
    const { files, calls } = make();
    let pulled = false;
    async function* gen() {
      pulled = true;
      yield Uint8Array.from([1]);
    }
    await expect(files.writeStream('../x.mp4', gen())).rejects.toThrow(/path/i);
    await expect(files.size('../x.mp4')).rejects.toThrow(/path/i);
    expect(pulled).toBe(false);
    expect(calls).toEqual([]);
    await expect(files.writeStream('media/ok.mp4', gen())).resolves.toBe('file:///data/media/ok.mp4');
  });

  it('size answers the stat size and rejects for a missing file', async () => {
    const { files, store } = make();
    store.set('media/v.mp4', new Uint8Array(1234));
    await expect(files.size('media/v.mp4')).resolves.toBe(1234);
    await expect(files.size('media/none.mp4')).rejects.toThrow();
  });
});
