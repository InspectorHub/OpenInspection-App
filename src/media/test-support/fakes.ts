import type { Http, HttpRequest, HttpResponse } from '../../auth/http';
import { createMemoryFiles, type MemoryFiles } from '../../app/test-support/memory-files';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import type { UploaderPluginLike, UploaderStartOptions, UploaderEventLike } from '../../platform/uploader';
import { createMediaStore, type MediaStore } from '../store';

export const ORIGIN = 'https://oi.example.test';
export const INSPECTION = 'insp-1';
export const TENANT = 'tenant-1';

/** A JPEG-looking payload; the content is opaque to everything under test. */
export function jpegBytes(seed = 1, length = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.fill(seed);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
}

export function jpegBlob(seed = 1, length = 64, type = 'image/jpeg'): Blob {
  return new Blob([jpegBytes(seed, length)], { type });
}

export function response(status: number, body?: unknown, extra: Partial<HttpResponse> = {}): HttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { status, headers: new Headers(), text, json: body, retryAfterMs: null, upgrade: null, ...extra };
}

export interface RecordingHttp extends Http {
  calls: HttpRequest[];
}

export function recordingHttp(handler: (req: HttpRequest, n: number) => HttpResponse | Promise<HttpResponse>): RecordingHttp {
  const calls: HttpRequest[] = [];
  return {
    calls,
    request: (req) => {
      calls.push(req);
      return Promise.resolve(handler(req, calls.length));
    },
  };
}

/**
 * Stands in for the engine's two photo routes: the signed-URL mint and the token-only upload route.
 * The object key is a pure function of the token, so a repeated upload overwrites one object, as on the server.
 */
export interface FakeEngine {
  http: RecordingHttp;
  objects: Map<string, Uint8Array>;
  /** Every request body the mint route saw. */
  minted: { pendingId: string; contentType: string; url: string }[];
  /** Answers for the next uploads, consumed in order; 200 when empty. */
  uploadStatuses: number[];
  /** Replaces the whole mint answer for the next mint(s). */
  mintOverride: ((req: HttpRequest, n: number) => HttpResponse) | null;
  /** The upload route: returns the HTTP status for a POST of `bytes` to `serverUrl`. */
  receive(serverUrl: string, bytes: Uint8Array): number;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' };

export function createFakeEngine(): FakeEngine {
  const objects = new Map<string, Uint8Array>();
  const tokenToKey = new Map<string, string>();
  const minted: FakeEngine['minted'] = [];
  let tokens = 0;
  const engine: FakeEngine = {
    objects,
    minted,
    uploadStatuses: [],
    mintOverride: null,
    http: recordingHttp((req, n) => {
      if (engine.mintOverride) return engine.mintOverride(req, n);
      const match = /\/api\/inspections\/([^/]+)\/media\/upload-url$/.exec(req.url);
      if (req.method !== 'POST' || !match || !req.body) return response(404);
      const body = JSON.parse(req.body) as { pendingId: string; contentType: string };
      const ext = EXT[body.contentType];
      if (!ext) return response(400);
      tokens += 1;
      const token = `payload${String(tokens).padStart(4, '0')}.signature${String(tokens).padStart(4, '0')}`;
      const key = `${TENANT}/inspections/${match[1] ?? ''}/photos/${body.pendingId}.${ext}`;
      tokenToKey.set(token, key);
      const url = `/api/public/uploads/photo?token=${encodeURIComponent(token)}`;
      minted.push({ pendingId: body.pendingId, contentType: body.contentType, url });
      return response(200, { success: true, data: { url, key, expiresAt: 9_999_999_999_999 } });
    }),
    receive: (serverUrl, bytes) => {
      const queued = engine.uploadStatuses.shift();
      if (queued !== undefined && (queued < 200 || queued > 299)) return queued;
      const token = new URL(serverUrl).searchParams.get('token') ?? '';
      const key = tokenToKey.get(token);
      if (!key) return 401;
      objects.set(key, bytes);
      return 200;
    },
  };
  return engine;
}

export type PluginBehavior =
  /** The upload finishes with this HTTP status (the fake engine decides when `engine` is set). */
  | { kind: 'complete'; statusCode?: number }
  /** A `failed` event, optionally carrying a status. */
  | { kind: 'fail'; statusCode?: number }
  /** Nothing is ever reported (the process is about to die, or the event was lost). */
  | { kind: 'hang' }
  /** `startUpload` itself rejects. */
  | { kind: 'reject' }
  /** The `completed` event is delivered before `startUpload` resolves. */
  | { kind: 'complete-early'; statusCode?: number };

export interface FakePlugin extends UploaderPluginLike {
  starts: UploaderStartOptions[];
  removed: string[];
  acks: string[];
  listenerCount(): number;
  /** Delivers an event to every registered listener. */
  emit(event: UploaderEventLike): void;
  /** Behaviours for the next starts, consumed in order; `default` afterwards. */
  script: PluginBehavior[];
  defaultBehavior: PluginBehavior;
  /** Resolves once `n` uploads were started. */
  whenStarted(n: number): Promise<void>;
  /** Uploads started and not yet reported finished or failed. */
  inFlight(): number;
  /** The most uploads that were ever in flight at once. */
  maxInFlight(): number;
  /** Finishes a held (`hang`) upload as the server would answer it. */
  finish(id: string, statusCode?: number): void;
  /** Ids of uploads that were started and are still held. */
  heldIds(): string[];
}

/** Plugin double. `read` maps the file uri it was handed back to bytes; `engine` receives the upload. */
export function createFakePlugin(deps: { engine?: { receive(serverUrl: string, bytes: Uint8Array, mimeType: string): number }; files?: MemoryFiles; idPrefix?: string }): FakePlugin {
  const listeners = new Set<(event: UploaderEventLike) => void>();
  const waiters: { n: number; resolve: () => void }[] = [];
  const prefix = deps.idPrefix ?? 'up';
  let counter = 0;
  let flying = 0;
  let peak = 0;
  const held = new Map<string, UploaderStartOptions>();
  const tracked = new Set<string>();
  const emitCompleted = (id: string, options: UploaderStartOptions, statusCode: number | undefined): void => {
    let status = statusCode;
    if (status === undefined) {
      const path = options.filePath.replace(/^file:\/\/\//, '');
      const bytes = deps.files ? deps.files.bytes(path) : undefined;
      status = deps.engine && bytes ? deps.engine.receive(options.serverUrl, bytes, options.mimeType) : 200;
    }
    plugin.emit({ name: 'completed', id, eventId: `ev-${id}`, payload: { statusCode: status } });
  };
  const plugin: FakePlugin = {
    starts: [],
    removed: [],
    acks: [],
    script: [],
    defaultBehavior: { kind: 'complete' },
    listenerCount: () => listeners.size,
    emit: (event) => {
      if (typeof event === 'object' && event !== null && (event.name === 'completed' || event.name === 'failed') && tracked.delete(event.id)) flying -= 1;
      for (const listener of [...listeners]) listener(event);
    },
    inFlight: () => flying,
    maxInFlight: () => peak,
    heldIds: () => [...held.keys()],
    finish: (id, statusCode) => {
      const options = held.get(id);
      if (!options) throw new Error('no held upload with that id');
      held.delete(id);
      emitCompleted(id, options, statusCode);
    },
    whenStarted: (n) =>
      plugin.starts.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ n, resolve });
          }),
    addListener: (_name, callback) => {
      listeners.add(callback);
      return Promise.resolve({
        remove: () => {
          listeners.delete(callback);
          return Promise.resolve();
        },
      });
    },
    acknowledgeEvent: ({ eventId }) => {
      plugin.acks.push(eventId);
      return Promise.resolve();
    },
    removeUpload: ({ id }) => {
      plugin.removed.push(id);
      return Promise.resolve();
    },
    startUpload: async (options) => {
      plugin.starts.push(options);
      counter += 1;
      const id = `${prefix}-${String(counter)}`;
      const behavior = plugin.script.shift() ?? plugin.defaultBehavior;
      for (const w of [...waiters]) {
        if (plugin.starts.length >= w.n) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
      if (behavior.kind === 'reject') throw new Error('plugin refused /secret/path/file.jpg');
      tracked.add(id);
      flying += 1;
      peak = Math.max(peak, flying);
      if (behavior.kind === 'hang') held.set(id, options);
      else if (behavior.kind === 'complete-early') emitCompleted(id, options, behavior.statusCode);
      else if (behavior.kind === 'complete') {
        void Promise.resolve().then(() => {
          emitCompleted(id, options, behavior.statusCode);
        });
      } else if (behavior.kind === 'fail') {
        const { statusCode } = behavior;
        void Promise.resolve().then(() => {
          plugin.emit({
            name: 'failed',
            id,
            eventId: `ev-${id}`,
            payload: statusCode === undefined ? { error: 'boom /secret/path' } : { error: 'boom', statusCode },
          });
        });
      }
      return { id };
    },
  };
  return plugin;
}

export interface MediaWorld {
  db: Db;
  files: MemoryFiles;
  store: MediaStore;
  engine: FakeEngine;
}

export async function createMediaWorld(): Promise<MediaWorld> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const files = createMemoryFiles();
  const store = createMediaStore({ db, files });
  return { db, files, store, engine: createFakeEngine() };
}

export function photoRecord(pendingId: string, overrides: { inspectionId?: string; createdAt?: number; seed?: number; type?: string } = {}) {
  return {
    pendingId,
    inspectionId: overrides.inspectionId ?? INSPECTION,
    kind: 'photo' as const,
    blob: jpegBlob(overrides.seed ?? 1, 64, overrides.type ?? 'image/jpeg'),
    createdAt: overrides.createdAt ?? 1_000,
    meta: { targetType: 'item' as const, findingKey: '_default:s1:i1', itemId: 'i1' },
  };
}
