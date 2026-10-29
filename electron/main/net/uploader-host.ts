import * as Fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, MEDIA_CONTENT_TYPES, PHOTO_CONTENT_TYPES } from '../../../src/media/media-types.ts';
import type { TimerPort } from '../../../src/collab/timers.ts';
import type { UploaderEventLike } from '../../../src/platform/uploader.ts';
import type { UploaderStartOptions } from '../../shared/ipc-contract.ts';

export interface UploadTransport {
  send(req: { url: string; headers: Record<string, string>; fileField: string; fileName: string; mimeType: string; file: { path: string; size: number }; signal: AbortSignal; onProgress(sent: number, total: number): void }): Promise<{ statusCode: number }>;
}
export interface UploaderHost {
  start(o: UploaderStartOptions): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  abortAll(reason: 'suspend' | 'quit'): void;
  activeCount(): number;
  onEvent(listener: (event: UploaderEventLike) => void): () => void;
  onActiveCountChange(listener: (count: number) => void): () => void;
}
export type ResolvedMediaFile = { path: string; size: number };
export type ResolveMediaFile = (fileUri: string) => Promise<ResolvedMediaFile>;
export interface MediaFileResolverDeps { fs: typeof Fs; mediaRoot: string; cacheRoot: string }

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MIME_TYPES = new Set(Object.keys(MEDIA_CONTENT_TYPES));
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const RETRY_DELAYS = [1000, 2000, 4000] as const;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function createMediaFileResolver(deps: MediaFileResolverDeps): ResolveMediaFile {
  return async (fileUri) => {
    if (typeof fileUri !== 'string' || fileUri.length > 2048 || !NO_CONTROL.test(fileUri)) throw new Error('file-missing');
    let url: URL;
    try { url = new URL(fileUri); } catch { throw new Error('file-missing'); }
    if (url.protocol !== 'file:' || url.hostname !== '' || url.username !== '' || url.password !== '' || url.search || url.hash) throw new Error('file-missing');
    let path: string;
    try { path = fileURLToPath(url); } catch { throw new Error('file-missing'); }
    const root = await deps.fs.realpath(deps.mediaRoot);
    const cache = await deps.fs.realpath(deps.cacheRoot).catch(() => deps.cacheRoot);
    const real = await deps.fs.realpath(path);
    const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!inside(normalize(root), normalize(real)) || inside(normalize(cache), normalize(real))) throw new Error('file-missing');
    const stat = await deps.fs.stat(real);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error('file-missing');
    return { path: real, size: stat.size };
  };
}

interface ActiveUpload {
  id: string;
  controller: AbortController;
  removed: boolean;
  terminal: boolean;
  percent: number;
  cancelCode: string | null;
  cancelled: Promise<void>;
  signalCancelled(): void;
  done: Promise<void>;
}

function validateOptions(options: UploaderStartOptions, packaged: boolean): void {
  if (options.method !== 'POST' || options.uploadType !== 'multipart') throw new Error('invalid-argument');
  if (typeof options.serverUrl !== 'string' || options.serverUrl.length > 2048 || !NO_CONTROL.test(options.serverUrl)) throw new Error('invalid-argument');
  let url: URL;
  try { url = new URL(options.serverUrl); } catch { throw new Error('invalid-argument'); }
  if (url.username || url.password || url.hash || (packaged ? url.protocol !== 'https:' : url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('invalid-argument');
  if (Object.keys(options.headers).some((name) => name !== name.toLowerCase())) throw new Error('invalid-argument');
  for (const name of Object.keys(options.headers)) if (name !== 'x-client-version' && name !== 'x-client-platform') throw new Error('invalid-argument');
  if (options.headers['x-client-version'] !== undefined && !VERSION.test(options.headers['x-client-version']!)) throw new Error('invalid-argument');
  if (options.headers['x-client-platform'] !== 'windows') throw new Error('invalid-argument');
  if (!FIELD.test(options.fileField) || !MIME_TYPES.has(options.mimeType)) throw new Error('invalid-argument');
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 5) throw new Error('invalid-argument');
  if (typeof options.notificationTitle !== 'string' || options.notificationTitle.length < 1 || options.notificationTitle.length > 80 || !NO_CONTROL.test(options.notificationTitle)) throw new Error('invalid-argument');
}

function failureCode(error: unknown, cancelCode: string | null): 'network' | 'timeout' | 'aborted' | 'file-missing' {
  if (cancelCode === 'timeout') return 'timeout';
  if (cancelCode === 'aborted' || (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ABORT_ERR')) return 'aborted';
  if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(String((error as { code?: unknown }).code))) return 'file-missing';
  if (error instanceof Error && error.message === 'file-missing') return 'file-missing';
  return 'network';
}

export function createUploaderHost(deps: { transport: UploadTransport; resolveMediaFile: ResolveMediaFile; timers: TimerPort; random(): number; packaged: boolean }): UploaderHost {
  const active = new Map<string, ActiveUpload>();
  const eventListeners = new Set<(event: UploaderEventLike) => void>();
  const activeListeners = new Set<(count: number) => void>();
  const emit = (item: ActiveUpload, name: string, payload?: UploaderEventLike['payload']): void => {
    if (item.removed || item.terminal) return;
    const event: UploaderEventLike = payload === undefined ? { name, id: item.id } : { name, id: item.id, payload };
    for (const listener of eventListeners) { try { listener(event); } catch { /* listeners cannot disrupt an upload */ } }
  };
  const notifyCount = (): void => { for (const listener of activeListeners) { try { listener(active.size); } catch { /* listener isolation */ } } };
  const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    let finished = false;
    const done = (error?: Error): void => {
      if (finished) return;
      finished = true; deps.timers.clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => done(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    const timer = deps.timers.setTimeout(() => done(), ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  const run = async (item: ActiveUpload, options: UploaderStartOptions, file: ResolvedMediaFile): Promise<void> => {
    const filename = file.path.split(/[\\/]/).at(-1) ?? 'upload.bin';
    let responseStatus: number | null = null;
    let error: unknown;
    const timer = deps.timers.setTimeout(() => { if (!item.terminal && !item.removed) { item.cancelCode = 'timeout'; item.controller.abort(); } }, UPLOAD_TIMEOUT_MS);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await deps.transport.send({ url: options.serverUrl, headers: options.headers, fileField: options.fileField, fileName: filename, mimeType: options.mimeType,
            file, signal: item.controller.signal, onProgress: (sent, total) => {
              if (!Number.isFinite(sent) || !Number.isFinite(total) || total <= 0) return;
              const percent = Math.max(item.percent, Math.min(99, Math.floor(Math.max(0, sent) / total * 100)));
              if (percent > item.percent && !item.removed && !item.terminal) { item.percent = percent; emit(item, 'uploading', { percent }); }
            } });
          responseStatus = response.statusCode;
          break;
        } catch (caught) {
          error = caught;
          const code = failureCode(caught, item.cancelCode);
          if (item.controller.signal.aborted || code === 'file-missing' || code === 'aborted' || code === 'timeout' || attempt >= options.maxRetries) break;
          const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]!;
          await wait(delay, item.controller.signal);
        }
      }
    } catch (caught) { error = caught; }
    finally { deps.timers.clearTimeout(timer); }
    if (item.removed || item.terminal) return;
    item.terminal = true;
    if (responseStatus !== null) {
      const event: UploaderEventLike = { name: 'completed', id: item.id, payload: { statusCode: responseStatus } };
      for (const listener of eventListeners) { try { listener(event); } catch { /* isolate listeners */ } }
    } else {
      const code = failureCode(error, item.cancelCode);
      const event: UploaderEventLike = { name: 'failed', id: item.id, payload: { error: code } };
      for (const listener of eventListeners) { try { listener(event); } catch { /* isolate listeners */ } }
    }
  };

  return {
    async start(options) {
      validateOptions(options, deps.packaged);
      const id = randomUUID();
      let signalCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => { signalCancelled = resolve; });
      const item: ActiveUpload = { id, controller: new AbortController(), removed: false, terminal: false, percent: 0, cancelCode: null, cancelled, signalCancelled, done: Promise.resolve() };
      active.set(id, item); notifyCount();
      let markStarted!: () => void;
      let rejectStarted!: (error: Error) => void;
      const started = new Promise<void>((resolve, reject) => { markStarted = resolve; rejectStarted = reject; });

      // Register before resolving the renderer-supplied URI. A teardown can then cancel this accepted start,
      // and the resolver's eventual result cannot launch transport after cancellation.
      item.done = (async () => {
        let resolution: { kind: 'file'; file: ResolvedMediaFile } | { kind: 'cancelled' };
        try {
          resolution = await Promise.race([
            deps.resolveMediaFile(options.filePath).then((file): { kind: 'file'; file: ResolvedMediaFile } => ({ kind: 'file', file })),
            item.cancelled.then((): { kind: 'cancelled' } => ({ kind: 'cancelled' })),
          ]);
        } catch {
          rejectStarted(new Error('file-missing'));
          return;
        }
        if (resolution.kind === 'cancelled' || item.removed || item.terminal) {
          markStarted();
          return;
        }
        const maximum = Object.hasOwn(PHOTO_CONTENT_TYPES, options.mimeType) ? MAX_MEDIA_BYTES : MAX_VIDEO_BYTES;
        if (!Number.isSafeInteger(resolution.file.size) || resolution.file.size <= 0 || resolution.file.size > maximum) {
          rejectStarted(new Error('invalid-argument'));
          return;
        }
        markStarted();
        await run(item, options, resolution.file);
      })().finally(() => {
        if (active.delete(id)) notifyCount();
      });
      // Keep file/size failures as start rejections; cancellation is represented by the terminal event.
      await started;
      return { id };
    },
    async remove(id) {
      const item = active.get(id);
      if (!item) return;
      item.removed = true; item.cancelCode = 'aborted'; item.controller.abort();
      item.signalCancelled();
      await item.done;
    },
    abortAll(reason) {
      const code = reason === 'suspend' || reason === 'quit' ? 'aborted' : 'aborted';
      for (const item of active.values()) {
        if (item.terminal || item.removed) continue;
        item.cancelCode = code;
        item.controller.abort();
        item.terminal = true;
        const event: UploaderEventLike = { name: 'failed', id: item.id, payload: { error: code } };
        for (const listener of eventListeners) { try { listener(event); } catch { /* isolate listeners */ } }
        item.signalCancelled();
      }
    },
    activeCount: () => active.size,
    onEvent(listener) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
    onActiveCountChange(listener) { activeListeners.add(listener); return () => { activeListeners.delete(listener); }; },
  };
}
