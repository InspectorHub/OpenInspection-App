import type * as Fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IpcError, type FileEntryLike, type FilesBridge } from '../../shared/ipc-contract.ts';
import { assertSafeRelativePath } from '../../../src/platform/files-path.ts';
import { MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, sniffMediaKind } from '../../../src/media/media-types.ts';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export interface FilesHostDeps {
  fs: typeof Fs;
  /** Root for application media files (the `media/` Files path prefix is stripped). */
  mediaRoot: string;
  cacheRoot: string;
  clock: Clock;
}

interface ActiveWrite {
  handle: string;
  file: Awaited<ReturnType<typeof import('node:fs/promises')['open']>>;
  path: string;
  partPath: string;
  targetPath: string;
  area: 'media' | 'cache';
  bytes: number;
  header: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
  committing: boolean;
  completion?: Promise<string>;
}

const MAX_ACTIVE = 4;
const IDLE_TIMEOUT_MS = 60_000;
const MEDIA_EXTENSIONS = new Set(['jpg', 'png', 'heic', 'mp4', 'mov']);
const PHOTO_EXTENSIONS = new Set(['jpg', 'png', 'heic']);

const mapFsError = (error: unknown): never => {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOSPC') throw new IpcError('disk-full');
  throw error;
};

function checkedRelative(path: string): string {
  try { assertSafeRelativePath(path); } catch { throw new IpcError('invalid-argument'); }
  if (path.length > 200 || path.startsWith('/') || path.startsWith('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')) throw new IpcError('invalid-argument');
  for (const segment of path.split('/')) {
    if (/[. ]$/.test(segment) || /:/.test(segment) || /[\u0000-\u001f]/.test(segment)) throw new IpcError('invalid-argument');
    const stem = segment.split('.')[0]!.trimEnd().toUpperCase();
    if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/.test(stem)) throw new IpcError('invalid-argument');
  }
  return path;
}

function mediaRelative(path: string): string {
  if (path === 'media') return '';
  return path.startsWith('media/') ? path.slice('media/'.length) : path;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function extension(path: string): string {
  const leaf = basename(path);
  return leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.') + 1).toLowerCase() : '';
}

function headerLength(path: string, prefix: Uint8Array<ArrayBufferLike> = new Uint8Array()): number {
  const ext = extension(path);
  if (ext === 'jpg') return 3;
  if (ext === 'png') return 8;
  if (ext === 'mp4' || ext === 'mov') return 8;
  if (prefix.length < 12) return 12;
  const size = ((prefix[0] ?? 0) * 2 ** 24) + ((prefix[1] ?? 0) << 16) + ((prefix[2] ?? 0) << 8) + (prefix[3] ?? 0);
  return size >= 16 && size <= 4096 ? size : 12;
}

function validHeader(path: string, bytes: Uint8Array): boolean {
  const ext = extension(path);
  if (!MEDIA_EXTENSIONS.has(ext) || bytes.length < headerLength(path, bytes)) return false;
  if (ext === 'jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === 'png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
  if (ext === 'heic') return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 && sniffMediaKind(bytes) === 'heic';
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function mediaLimit(path: string): number {
  return PHOTO_EXTENSIONS.has(extension(path)) ? MAX_MEDIA_BYTES : MAX_VIDEO_BYTES;
}

export function createFilesHost(deps: FilesHostDeps): FilesBridge & { dispose(): Promise<void>; abortAll(): Promise<void> } {
  const { fs, clock } = deps;
  const roots = { media: resolve(deps.mediaRoot), cache: resolve(deps.cacheRoot) };
  const active = new Map<string, ActiveWrite>();
  const waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let activeSlots = 0;
  let counterPromise: Promise<number> | null = null;
  let mediaCount = 0;
  let commitQueue: Promise<void> = Promise.resolve();

  async function ensureRoot(area: 'media' | 'cache'): Promise<string> {
    await fs.mkdir(roots[area], { recursive: true });
    return fs.realpath(roots[area]);
  }

  async function resolveSafe(area: 'media' | 'cache', raw: string, createParent = false): Promise<string> {
    const safe = checkedRelative(raw);
    const relativePath = area === 'media' ? mediaRelative(safe) : safe;
    if (relativePath === '') throw new IpcError('invalid-argument');
    const root = await ensureRoot(area);
    const segments = relativePath.split('/');
    let current = root;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const next = join(current, segment);
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink()) {
          const real = await fs.realpath(next);
          if (!inside(root, real)) throw new IpcError('invalid-argument');
          current = real;
        } else if (!stat.isDirectory()) throw new IpcError('invalid-argument');
        else current = next;
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        if (!createParent) return join(next, ...segments.slice(index + 1));
        await fs.mkdir(next).catch((mkdirError: unknown) => { if (code(mkdirError) !== 'EEXIST') mapFsError(mkdirError); });
        current = next;
      }
      const real = await fs.realpath(current);
      if (!inside(root, real)) throw new IpcError('invalid-argument');
      current = real;
    }
    const target = join(current, segments.at(-1)!);
    if (!inside(root, target)) throw new IpcError('invalid-argument');
    try {
      const realTarget = await fs.realpath(target);
      if (!inside(root, realTarget)) throw new IpcError('invalid-argument');
    } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    return target;
  }

  function inside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  }
  async function openedFileIsAtPath(file: Awaited<ReturnType<typeof import('node:fs/promises')['open']>>, path: string, root: string): Promise<boolean> {
    const [opened, named, real] = await Promise.all([file.stat(), fs.stat(path), fs.realpath(path)]);
    return opened.isFile() && named.isFile() && opened.dev === named.dev && opened.ino === named.ino && inside(root, real);
  }
  function code(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined; }

  async function acquire(): Promise<void> {
    if (activeSlots < MAX_ACTIVE) { activeSlots += 1; return; }
    await new Promise<void>((resolveWait, reject) => waiters.push({ resolve: resolveWait, reject }));
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next.resolve();
    else activeSlots = Math.max(0, activeSlots - 1);
  }
  async function countMedia(): Promise<number> {
    if (counterPromise === null) counterPromise = (async () => {
      const root = await ensureRoot('media');
      const visit = async (dir: string): Promise<number> => {
        let count = 0;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name.endsWith('.part')) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) count += await visit(path);
          else if (entry.isFile()) count += 1;
        }
        return count;
      };
      return visit(root);
    })().then((count) => { mediaCount = count; return count; });
    await counterPromise;
    return mediaCount;
  }
  async function cleanup(item: ActiveWrite): Promise<void> {
    if (item.done || item.committing) return;
    item.done = true;
    clock.clearTimeout(item.timer);
    active.delete(item.handle);
    await item.file.close().catch(() => undefined);
    await fs.unlink(item.partPath).catch(() => undefined);
    release();
  }
  function touch(item: ActiveWrite): void {
    clock.clearTimeout(item.timer);
    item.timer = clock.setTimeout(() => { if (!item.committing) void cleanup(item); }, IDLE_TIMEOUT_MS);
  }
  async function createStream(area: 'media' | 'cache', path: string): Promise<{ handle: string }> {
    checkedRelative(path);
    await acquire();
    let opened: Awaited<ReturnType<typeof import('node:fs/promises')['open']>> | null = null;
    try {
      const targetPath = await resolveSafe(area, path, true);
      const partPath = `${targetPath}.part`;
      const file = await fs.open(partPath, 'wx');
      opened = file;
      const root = await ensureRoot(area);
      if (!(await openedFileIsAtPath(file, partPath, root))) {
        await file.close();
        opened = null;
        await fs.unlink(partPath).catch(() => undefined);
        throw new IpcError('invalid-argument');
      }
      const handle = randomUUID();
      const item: ActiveWrite = { handle, file, path, partPath, targetPath, area, bytes: 0, header: new Uint8Array(), timer: undefined as never, done: false, committing: false };
      item.timer = clock.setTimeout(() => { if (!item.committing) void cleanup(item); }, IDLE_TIMEOUT_MS);
      active.set(handle, item);
      opened = null;
      return { handle };
    } catch (error) { await opened?.close().catch(() => undefined); release(); return mapFsError(error); }
  }
  function getHandle(handle: string): ActiveWrite {
    const item = active.get(handle);
    if (!item || item.done) throw new IpcError('not-found');
    return item;
  }

  const bridge: FilesBridge & { dispose(): Promise<void>; abortAll(): Promise<void> } = {
    async write(path, data) {
      const { handle } = await createStream('media', path);
      try { await bridge.stream.append(handle, data); return await bridge.stream.finish(handle, 'commit'); }
      catch (error) { await bridge.stream.finish(handle, 'abort').catch(() => undefined); throw error; }
    },
    async size(path) {
      const target = await resolveSafe('media', path);
      try {
        const file = await fs.open(target, 'r');
        try { if (!(await openedFileIsAtPath(file, target, await ensureRoot('media')))) throw new IpcError('invalid-argument'); return (await file.stat()).size; }
        finally { await file.close(); }
      } catch (error) { return mapFsError(error); }
    },
    async read(path) {
      const target = await resolveSafe('media', path);
      try {
        const file = await fs.open(target, 'r');
        try { if (!(await openedFileIsAtPath(file, target, await ensureRoot('media')))) throw new IpcError('invalid-argument'); return new Uint8Array(await file.readFile()); }
        finally { await file.close(); }
      } catch (error) { return mapFsError(error); }
    },
    async remove(path) {
      const target = await resolveSafe('media', path);
      const previous = commitQueue;
      let releaseCommit!: () => void;
      commitQueue = new Promise<void>((resolveCommit) => { releaseCommit = resolveCommit; });
      await previous;
      try {
        let regularFile = false;
        try { regularFile = (await fs.lstat(target)).isFile(); }
        catch (error) { if (code(error) === 'ENOENT') return; mapFsError(error); }
        try {
          await fs.unlink(target);
          if (regularFile && counterPromise !== null) mediaCount = Math.max(0, mediaCount - 1);
        } catch (error) { if (code(error) !== 'ENOENT') mapFsError(error); }
      } finally { releaseCommit(); }
    },
    async displayUrl(path) { const safe = checkedRelative(path); return `oi-media://media/${encodePath(mediaRelative(safe))}`; },
    async fileUri(path) { return pathToFileURL(await resolveSafe('media', path)).href; },
    async exists(path) { const target = await resolveSafe('media', path); try { await fs.stat(target); return true; } catch (error) { if (code(error) === 'ENOENT') return false; return mapFsError(error); } },
    async list(directoryPath) {
      const target = directoryPath === '' || directoryPath === 'media' ? await ensureRoot('media') : await resolveSafe('media', directoryPath);
      try { return await entries(fs, target); } catch (error) { if (code(error) === 'ENOENT') return []; return mapFsError(error); }
    },
    async removeCache(path) { const target = await resolveSafe('cache', path); try { await fs.unlink(target); } catch (error) { if (code(error) !== 'ENOENT') mapFsError(error); } },
    async listCache() {
      try { return await entries(fs, await fs.realpath(roots.cache)); }
      catch (error) { if (code(error) === 'ENOENT') return []; return mapFsError(error); }
    },
    stream: {
      open: createStream,
      async append(handle, chunk) {
        const item = getHandle(handle);
        try {
          const limit = item.area === 'media' ? mediaLimit(item.path) : Number.MAX_SAFE_INTEGER;
          if (item.bytes + chunk.byteLength > limit) throw new IpcError('invalid-argument');
          item.bytes += chunk.byteLength;
          if (item.area === 'media') {
            const combined = new Uint8Array(item.header.length + chunk.length);
            combined.set(item.header); combined.set(chunk, item.header.length);
            const needed = headerLength(item.path, combined);
            if (item.header.length < needed) {
              item.header = combined.subarray(0, Math.min(needed, combined.length));
              if (combined.length < needed) { touch(item); return; }
              if (!validHeader(item.path, item.header)) throw new IpcError('invalid-argument');
              await item.file.write(item.header);
              if (combined.length > needed) await item.file.write(combined.subarray(needed));
            } else await item.file.write(chunk);
          } else await item.file.write(chunk);
          touch(item);
        } catch (error) {
          await cleanup(item);
          return mapFsError(error);
        }
      },
      async finish(handle, outcome) {
        const item = getHandle(handle);
        if (outcome === 'abort') { await cleanup(item); return ''; }
        item.committing = true;
        clock.clearTimeout(item.timer);
        item.completion = (async () => {
          const previous = commitQueue;
          let releaseCommit!: () => void;
          commitQueue = new Promise<void>((resolveCommit) => { releaseCommit = resolveCommit; });
          await previous;
          try {
          let existing = false;
          if (item.area === 'media' && (item.bytes === 0 || item.header.length < headerLength(item.path, item.header))) throw new IpcError('invalid-argument');
          if (item.area === 'media') {
            existing = await fs.stat(item.targetPath).then(() => true, (error: unknown) => code(error) === 'ENOENT' ? false : Promise.reject(error));
            if (!existing && await countMedia() >= 10_000) throw new IpcError('invalid-argument');
          }
          await item.file.sync();
          await item.file.close();
          // Renaming over the target replaces it in one step (MoveFileEx with MOVEFILE_REPLACE_EXISTING), so a write
          // to a path that is already there overwrites it, as the other platforms do, and a reader never sees a torn
          // file: until the rename the old content is intact, and a failed rename leaves it so (cleanup drops the part).
          await fs.rename(item.partPath, item.targetPath);
          if (item.area === 'media' && !existing) mediaCount += 1;
          const uri = pathToFileURL(item.targetPath).href;
          item.done = true; active.delete(handle); release();
          return uri;
          } catch (error) {
            item.committing = false;
            await cleanup(item);
            return mapFsError(error);
          } finally { releaseCommit(); }
        })();
        return item.completion;
      },
    },
    async abortAll() {
      for (const waiter of waiters.splice(0)) waiter.reject(new IpcError('not-found'));
      const committing = [...active.values()].map((item) => item.completion).filter((value): value is Promise<string> => value !== undefined);
      await Promise.all([...active.values()].filter((item) => !item.committing).map((item) => cleanup(item)));
      await Promise.allSettled(committing);
    },
    async dispose() { await bridge.abortAll(); },
  };
  return bridge;
}

async function entries(fs: typeof Fs, dir: string): Promise<FileEntryLike[]> {
  const rows = await fs.readdir(dir, { withFileTypes: true });
  const result: FileEntryLike[] = [];
  for (const row of rows) {
    const stat = await fs.stat(join(dir, row.name));
    result.push({ name: row.name, mtimeMs: stat.mtimeMs });
  }
  return result;
}
