import type { CommandResult, FieldResources, VideoUploadTicket } from '@inspectorhub/field-ui';
import { MediaError, isMediaError } from '../media/errors';
import type { ResolveResult } from '../media/pending-doc';
import type { MediaStore } from '../media/store';
import { resolveRelocatableUploadUrl } from '../media/upload-kinds';
import { blobVideoSource, type ResolveVideo } from '../media/video';
import type { IsBlocked } from '../offline/blocked';
import type { Clock } from '../platform/clock';
import { apiPath, type Api, type ApiOutcome } from './api-client';
import { bodyData, isRec, isSuccess, problemResult, serverMessage } from './commands-shared';
import { MESSAGES, blockedOf, failureOf, needsConnectionResult } from './messages';

/**
 * The editor's video flow (`resources.video`) and the document step of the reconciler (`resolveVideo`).
 *
 * Two ways a clip travels, chosen when the capture sheet asks for its upload slot:
 *
 *  - ONLINE with an R2 company: the engine's own routes, in the order the web capture sheet calls them (create-upload,
 *    the clip to the returned token route, the poster, finalize), all through the Bearer client.
 *  - OFFLINE, or with a Stream company (the app cannot post to Stream's host itself, only the background uploader
 *    does): the clip is written to the device store, and the three calls answer locally. `createUpload` answers a
 *    local ticket, `uploadFile` stores the clip and answers a synthetic reference, `finalize` answers an empty pool id.
 *    The reconciler then does the real create-upload, transfer and finalize in the background when it can
 *    (`createVideoStrategy`), and deletes the local copy only after `resolveVideo` accepts it.
 *
 * Offline-recorded video therefore shows up in the media pool after the connection returns, NOT on the item: the editor
 * has no pending-video entry in the document to hang it on. The capture sheet's own text for a local clip is the same
 * as for any clip.
 *
 * Nothing here throws: every failure is `{ ok: false, error }` with a readable sentence.
 */

export interface VideoAdapterDeps {
  api: Api;
  store: Pick<MediaStore, 'putVideo' | 'getRow'>;
  isBlocked: IsBlocked;
  /** Link state, synchronously. */
  isOnline(): boolean;
  /** The company's video backend (`SessionInfo.videoProvider`). */
  videoProvider(): 'r2' | 'stream';
  /** The stored, canonical server origin. */
  origin: string;
  clock: Clock;
  /** A fresh unique id (a UUID): the id of a clip recorded on the device. */
  newId(): string;
}

export interface VideoAdapter {
  video: NonNullable<FieldResources['video']>;
  /** The reconciler's document step for a clip: `resolved` only after the server holds the finalized clip. */
  resolveVideo: ResolveVideo;
}

const VIDEO_UPLOAD_PATH = '/api/public/uploads/video';
/** A clip is up to 200 MiB; the Bearer client's form timeout is for photos. */
const CLIP_TIMEOUT_MS = 600_000;
const LOCAL_TICKET_URL = 'device://clip-on-this-device';

type Fail = CommandResult<never>;

/** The sentence for a request that did not succeed: the server's own when it wrote one, else the usual one for the status. */
function refusal(outcome: ApiOutcome, fallback: string = MESSAGES.requestFailed): Fail {
  if (outcome.kind === 'problem') return failureOf(problemResult(outcome.problem).error ?? fallback);
  if (isSuccess(outcome.status)) return failureOf(fallback);
  const written = serverMessage(outcome.json);
  if (written !== undefined) return failureOf(written);
  if (outcome.status === 403) return failureOf(MESSAGES.forbidden);
  if (outcome.status === 413) return failureOf(MESSAGES.videoTooLarge);
  return failureOf(fallback);
}

function storeFailure(error: unknown): Fail {
  if (!isMediaError(error)) return failureOf(MESSAGES.videoNotPrepared);
  switch (error.code) {
    case 'TOO_LARGE':
      return failureOf(MESSAGES.videoTooLarge);
    case 'UNSUPPORTED_TYPE':
      return failureOf(MESSAGES.videoTypeUnsupported);
    case 'BLOCKED':
      return blockedOf();
    case 'DISK_FULL':
      return failureOf(MESSAGES.videoDiskFull);
    default:
      return failureOf(MESSAGES.videoNotPrepared);
  }
}

/** The single `token` of a ticket's upload address, which both the clip and the poster are sent with. */
function tokenOf(origin: string, ticket: VideoUploadTicket): string | null {
  const resolved = resolveRelocatableUploadUrl(origin, ticket.uploadURL, VIDEO_UPLOAD_PATH);
  return resolved === null ? null : new URL(resolved).searchParams.get('token');
}

export function createVideoAdapter(deps: VideoAdapterDeps): VideoAdapter {
  /** Clips this adapter handed a local ticket for: the id is the row's pending id. */
  const local = new Map<string, { inspectionId: string; itemId?: string }>();

  /** The id of a local ticket this adapter issued, or null for any other. */
  function localIdOf(ticket: VideoUploadTicket): string | null {
    const { ref } = ticket;
    const id = ref.provider === 'r2' ? ref.mediaId : ref.streamUid;
    return local.has(id) ? id : null;
  }

  async function createLocal(inspectionId: string, itemId: string | undefined): Promise<CommandResult<VideoUploadTicket>> {
    const id = `local-${deps.newId()}`;
    local.set(id, { inspectionId, ...(itemId === undefined ? {} : { itemId }) });
    const provider = deps.videoProvider();
    const ref = provider === 'stream' ? ({ provider: 'stream', streamUid: id } as const) : ({ provider: 'r2', mediaId: id, r2Key: `local/${id}.mp4` } as const);
    return { ok: true, data: { uploadURL: LOCAL_TICKET_URL, provider, ref } };
  }

  async function createOnline(inspectionId: string, itemId: string | undefined): Promise<CommandResult<VideoUploadTicket>> {
    const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'media', 'video', 'create-upload'), json: itemId === undefined ? {} : { itemId } });
    if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return refusal(outcome);
    const data = bodyData(outcome.json);
    const ref = data?.ref;
    if (data?.provider !== 'r2' || !isRec(ref) || ref.provider !== 'r2' || typeof ref.mediaId !== 'string' || typeof ref.r2Key !== 'string') return failureOf(MESSAGES.unreadableAnswer);
    // The engine names itself by its own public address, which may not be the one the app talks to.
    const uploadURL = resolveRelocatableUploadUrl(deps.origin, data.uploadURL, VIDEO_UPLOAD_PATH);
    if (uploadURL === null) return failureOf(MESSAGES.unreadableAnswer);
    return { ok: true, data: { uploadURL, provider: 'r2', ref: { provider: 'r2', mediaId: ref.mediaId, r2Key: ref.r2Key } } };
  }

  async function storeClip(id: string, file: Blob, onProgress: (pct: number) => void): Promise<CommandResult<{ mediaId: string; r2Key: string } | undefined>> {
    const entry = local.get(id);
    if (entry === undefined) return failureOf(MESSAGES.videoNotPrepared);
    try {
      await deps.store.putVideo({
        pendingId: id,
        inspectionId: entry.inspectionId,
        createdAt: deps.clock.now(),
        meta: entry.itemId === undefined ? {} : { itemId: entry.itemId },
        source: blobVideoSource(file),
      });
    } catch (error) {
      return storeFailure(error);
    }
    onProgress(100);
    return deps.videoProvider() === 'stream' ? { ok: true } : { ok: true, data: { mediaId: id, r2Key: `local/${id}.mp4` } };
  }

  async function sendClip(ticket: VideoUploadTicket, file: Blob, onProgress: (pct: number) => void): Promise<CommandResult<{ mediaId: string; r2Key: string } | undefined>> {
    const token = ticket.ref.provider === 'r2' ? tokenOf(deps.origin, ticket) : null;
    if (token === null) return failureOf(MESSAGES.requestFailed);
    onProgress(0);
    const form = new FormData();
    form.append('file', file, file instanceof File && file.name !== '' ? file.name : 'clip.mp4');
    const outcome = await deps.api.send({ method: 'POST', path: VIDEO_UPLOAD_PATH, query: { token }, form, timeoutMs: CLIP_TIMEOUT_MS });
    if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return refusal(outcome);
    const stored = bodyData(outcome.json);
    if (typeof stored?.mediaId !== 'string' || typeof stored.r2Key !== 'string' || stored.mediaId === '' || stored.r2Key === '') return failureOf(MESSAGES.unreadableAnswer);
    onProgress(100);
    return { ok: true, data: { mediaId: stored.mediaId, r2Key: stored.r2Key } };
  }

  async function guarded<T>(work: () => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RangeError) return failureOf(MESSAGES.invalidValue);
      return failureOf(MESSAGES.requestFailed);
    }
  }

  const video: VideoAdapter['video'] = {
    createUpload: (inspectionId, input) =>
      guarded(async () => {
        if (await deps.isBlocked(inspectionId)) return blockedOf();
        const itemId = input.itemId === undefined || input.itemId === '' ? undefined : input.itemId;
        const onDevice = !deps.isOnline() || deps.videoProvider() === 'stream';
        return onDevice ? createLocal(inspectionId, itemId) : createOnline(inspectionId, itemId);
      }),

    uploadFile: (ticket, file, onProgress) =>
      guarded(async () => {
        const id = localIdOf(ticket);
        return id === null ? sendClip(ticket, file, onProgress) : storeClip(id, file, onProgress);
      }),

    uploadPoster: (inspectionId, ticket, blob) =>
      guarded(async () => {
        // A clip on the device has no upload slot yet, so no poster can be stored for it. The poster is optional.
        if (localIdOf(ticket) !== null) return { ok: false };
        const token = tokenOf(deps.origin, ticket);
        if (token === null) return { ok: false };
        const form = new FormData();
        form.append('file', blob, 'poster.jpg');
        const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'media', 'video', 'r2-upload-poster'), query: { token }, form });
        const posterKey = outcome.kind === 'response' && isSuccess(outcome.status) ? bodyData(outcome.json)?.posterKey : undefined;
        return typeof posterKey === 'string' && posterKey !== '' ? { ok: true, data: { posterKey } } : { ok: false };
      }),

    setPoster: (inspectionId, input) =>
      guarded(async () => {
        // A clip on the device has no Stream video yet, so there is no frame to pick.
        if (local.has(input.streamUid)) return failureOf(MESSAGES.posterNotSaved);
        if (!deps.isOnline()) return needsConnectionResult();
        const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'media', 'video', 'poster'), json: { streamUid: input.streamUid, posterPct: input.posterPct } });
        if (outcome.kind === 'problem') return failureOf(problemResult(outcome.problem).error ?? MESSAGES.requestFailed);
        return isSuccess(outcome.status) ? { ok: true } : failureOf(MESSAGES.posterNotSaved);
      }),

    finalize: (inspectionId, input) =>
      guarded(async () => {
        const id = input.provider === 'r2' ? input.mediaId : input.streamUid;
        if (local.has(id)) {
          // The clip is kept on the device and the reconciler finalizes it. Say so only for a clip that is really stored.
          const row = await deps.store.getRow(id);
          if (row === null || row.inspectionId !== inspectionId || row.kind !== 'video') return failureOf(MESSAGES.videoNotPrepared);
          local.delete(id);
          return { ok: true, data: { poolId: '' } };
        }
        const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'media', 'video', 'finalize'), json: input });
        if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return refusal(outcome);
        const poolId = bodyData(outcome.json)?.poolId;
        return { ok: true, data: { poolId: typeof poolId === 'string' ? poolId : '' } };
      }),

    remove: () => Promise.resolve(failureOf(MESSAGES.videoRemovalUnavailable)),
  };

  /**
   * Called by the reconciler after the background upload ended in success, which for a clip includes the server's
   * finalize. The row must still agree: it holds the key the server stored this clip under, and it is past `pending`.
   * Anything else keeps the file (`missing`, asked again later). A blocked inspection is refused with the block error.
   */
  const resolveVideo: ResolveVideo = async (inspectionId, pendingId, ref): Promise<ResolveResult> => {
    if (await deps.isBlocked(inspectionId)) throw new MediaError('BLOCKED');
    const row = await deps.store.getRow(pendingId);
    if (row === null || row.kind !== 'video' || row.inspectionId !== inspectionId) return 'missing';
    // Only `uploaded`: the uploader writes `uploading` together with the key BEFORE it finalizes, so that state does not yet mean the server holds the clip.
    if (row.state !== 'uploaded') return 'missing';
    const expected = ref.provider === 'r2' ? ref.r2Key : `stream/${ref.streamUid}`;
    return row.uploadedKey === expected ? 'resolved' : 'missing';
  };

  return { video, resolveVideo };
}

/**
 * The stack is built with its document step for clips, and the adapter needs the stack's store, which only exists once the
 * stack is built. This is the step the stack is given first: until `bind` hands it the real one it answers `missing`, which
 * keeps every file and asks again later, so nothing is deleted in the gap.
 */
export interface DeferredResolveVideo {
  resolveVideo: ResolveVideo;
  bind(resolve: ResolveVideo): void;
}

export function createDeferredResolveVideo(): DeferredResolveVideo {
  let bound: ResolveVideo | null = null;
  return {
    resolveVideo: (inspectionId, pendingId, ref) => (bound === null ? Promise.resolve('missing') : bound(inspectionId, pendingId, ref)),
    bind: (resolve) => {
      bound = resolve;
    },
  };
}
