import type { HttpRequest, HttpResponse } from '../../auth/http';
import type { VideoRecord } from '../store';
import { INSPECTION, ORIGIN, TENANT, recordingHttp, response, type FakeEngine, type RecordingHttp } from './fakes';

export const STREAM_HOST = 'upload.videodelivery.net';

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/** A clip-looking payload; the content is opaque to everything under test. */
export function videoBytes(seed = 1, length = 96): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.fill(seed);
  return bytes;
}

/** A record whose source yields its bytes in small pieces, so the store is exercised as a stream. */
export function videoRecord(
  pendingId: string,
  overrides: { inspectionId?: string; createdAt?: number; seed?: number; length?: number; type?: string; itemId?: string; durationSec?: number; declaredSize?: number } = {},
): VideoRecord {
  const bytes = videoBytes(overrides.seed ?? 1, overrides.length ?? 96);
  return {
    pendingId,
    inspectionId: overrides.inspectionId ?? INSPECTION,
    createdAt: overrides.createdAt ?? 1_000,
    meta: {
      ...(overrides.itemId === undefined ? { itemId: 'i1' } : { itemId: overrides.itemId }),
      ...(overrides.durationSec === undefined ? {} : { durationSec: overrides.durationSec }),
    },
    source: {
      contentType: overrides.type ?? 'video/mp4',
      size: overrides.declaredSize ?? bytes.length,
      chunks: async function* chunks() {
        for (let i = 0; i < bytes.length; i += 16) yield bytes.subarray(i, i + 16);
      },
    },
  };
}

export type Backend = 'r2' | 'stream';

export interface FakeVideoEngine {
  http: RecordingHttp;
  backend: Backend;
  /** Stored objects: the R2 key, or the Stream uid. */
  objects: Map<string, Uint8Array>;
  /** Pool rows by r2 key or stream uid, as `finalize` inserts them (one per key, however often finalize runs). */
  pool: Map<string, string>;
  /** Requests the create-upload route saw, with the JSON body parsed. */
  creates: { inspectionId: string; body: unknown }[];
  /** Requests the finalize route saw, with the JSON body parsed. */
  finalizes: { inspectionId: string; body: unknown }[];
  /** Replaces the status of the next create-upload answers, consumed in order. */
  createStatuses: number[];
  /** Replaces the status of the next finalize answers (the server still applies a 200 only), consumed in order. */
  finalizeStatuses: number[];
  /** Statuses for the next uploads, consumed in order; a non-2xx stores nothing. */
  uploadStatuses: number[];
  /** Makes the next finalize apply on the server but answer with a lost connection. */
  loseNextFinalizeAnswer(): void;
  /** Every token minted so far stops being accepted (their 24 h elapsed). */
  expireTokens(): void;
  /** Replaces the uploadURL of the next create-upload answers. */
  uploadUrlOverride: ((minted: string) => string) | null;
  /** Replaces the ref of the next create-upload answers. */
  refOverride: ((ref: Record<string, string>) => Record<string, string>) | null;
  /** The upload destination: R2 token route or the Stream host. Returns the HTTP status. */
  receive(serverUrl: string, bytes: Uint8Array, mimeType: string): number;
  /** The bearer value of every authenticated request the engine saw. */
  bearers: string[];
  /** While true every request fails as a dead network does. */
  down: boolean;
}

export function createFakeVideoEngine(initial: Backend = 'r2'): FakeVideoEngine {
  const tokens = new Map<string, { key: string; expired: boolean }>();
  let counter = 0;
  let losing = false;
  const engine: FakeVideoEngine = {
    backend: initial,
    objects: new Map(),
    pool: new Map(),
    creates: [],
    finalizes: [],
    createStatuses: [],
    finalizeStatuses: [],
    uploadStatuses: [],
    uploadUrlOverride: null,
    refOverride: null,
    bearers: [],
    down: false,
    loseNextFinalizeAnswer: () => {
      losing = true;
    },
    expireTokens: () => {
      for (const entry of tokens.values()) entry.expired = true;
    },
    http: recordingHttp(
      (req: HttpRequest): HttpResponse | Promise<HttpResponse> => {
        if (engine.down) return Promise.reject(new Error('network down'));
        const bearer = req.headers?.Authorization ?? '';
        engine.bearers.push(bearer);
        const create = /\/api\/inspections\/([^/]+)\/media\/video\/create-upload$/.exec(req.url);
        if (create) return handleCreate(decodeURIComponent(create[1] ?? ''), req);
        const finalize = /\/api\/inspections\/([^/]+)\/media\/video\/finalize$/.exec(req.url);
        if (finalize) return handleFinalize(decodeURIComponent(finalize[1] ?? ''), req);
        return response(404);
      },
    ),
    receive: (serverUrl, bytes, mimeType) => {
      const queued = engine.uploadStatuses.shift();
      if (queued !== undefined && (queued < 200 || queued > 299)) return queued;
      const url = new URL(serverUrl);
      if (url.hostname === STREAM_HOST) {
        engine.objects.set(url.pathname.slice(1), bytes);
        return 200;
      }
      const entry = tokens.get(url.searchParams.get('token') ?? '');
      if (!entry || entry.expired) return 401;
      const ext = EXT[mimeType];
      if (ext === undefined) return 400;
      // The real route stores under a key built from the token's media id and the declared type, never the placeholder's.
      const key = entry.key.replace(/\.mp4$/, `.${ext}`);
      engine.objects.set(key, bytes);
      return 200;
    },
  };

  function handleCreate(inspectionId: string, req: HttpRequest): HttpResponse {
    engine.creates.push({ inspectionId, body: req.body ? (JSON.parse(req.body) as unknown) : null });
    const forced = engine.createStatuses.shift();
    if (forced !== undefined) return response(forced, forced === 200 ? undefined : { error: { message: 'secret server text' } });
    counter += 1;
    if (engine.backend === 'stream') {
      const uid = `streamuid${String(counter).padStart(8, '0')}`;
      const uploadURL = engine.uploadUrlOverride ? engine.uploadUrlOverride(`https://${STREAM_HOST}/${uid}`) : `https://${STREAM_HOST}/${uid}`;
      const ref = engine.refOverride ? engine.refOverride({ provider: 'stream', streamUid: uid }) : { provider: 'stream', streamUid: uid };
      return response(200, { success: true, data: { uploadURL, provider: 'stream', ref } });
    }
    const mediaId = `media-${String(counter)}`;
    const token = `vtoken${String(counter).padStart(4, '0')}.vsignature${String(counter).padStart(4, '0')}`;
    const key = `${TENANT}/inspections/${inspectionId}/videos/${mediaId}.mp4`;
    tokens.set(token, { key, expired: false });
    const minted = `${ORIGIN}/api/public/uploads/video?token=${token}`;
    const uploadURL = engine.uploadUrlOverride ? engine.uploadUrlOverride(minted) : minted;
    const ref = engine.refOverride ? engine.refOverride({ provider: 'r2', mediaId, r2Key: key }) : { provider: 'r2', mediaId, r2Key: key };
    return response(200, { success: true, data: { uploadURL, provider: 'r2', ref } });
  }

  function handleFinalize(inspectionId: string, req: HttpRequest): HttpResponse | Promise<HttpResponse> {
    const body = (req.body ? JSON.parse(req.body) : {}) as Record<string, string>;
    engine.finalizes.push({ inspectionId, body });
    const forced = engine.finalizeStatuses.shift();
    if (forced !== undefined && forced !== 200) return response(forced, { error: { message: 'secret server text' } });
    const id = body.provider === 'stream' ? body.streamUid : body.r2Key;
    if (typeof id !== 'string') return response(400);
    if (body.provider === 'r2' && !id.includes(`/inspections/${inspectionId}/videos/`)) return response(400);
    if (!engine.objects.has(id) && body.provider === 'stream') return response(404);
    let poolId = engine.pool.get(id);
    if (poolId === undefined) {
      poolId = `pool-${String(engine.pool.size + 1)}`;
      engine.pool.set(id, poolId);
    }
    if (losing) {
      losing = false;
      return Promise.reject(new Error('connection lost'));
    }
    return response(200, { success: true, data: { poolId, streamUid: body.provider === 'stream' ? id : null, durationSec: null, readyToStream: true } });
  }

  return engine;
}

/**
 * One `Http` for the photo route and the video routes, and one upload `receive` for every destination, so a table
 * with both kinds runs through one uploader exactly as it does in the app.
 */
export function combinedEngine(photo: FakeEngine, video: FakeVideoEngine): { http: RecordingHttp; receive: (serverUrl: string, bytes: Uint8Array, mimeType: string) => number } {
  const http = recordingHttp((req) => (req.url.includes('/media/video/') ? video.http.request(req) : photo.http.request(req)));
  return {
    http,
    receive: (serverUrl, bytes, mimeType) => {
      const url = new URL(serverUrl);
      return url.hostname === STREAM_HOST || url.pathname === '/api/public/uploads/video' ? video.receive(serverUrl, bytes, mimeType) : photo.receive(serverUrl, bytes);
    },
  };
}
