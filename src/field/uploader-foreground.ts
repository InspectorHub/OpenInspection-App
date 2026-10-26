import type * as Y from 'yjs';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MAX_MEDIA_BYTES, PHOTO_CONTENT_TYPES } from '../media/store';
import { apiPath, type Api, type ApiOutcome } from './api-client';
import { bodyData, isSuccess, problemResult } from './commands-shared';
import { findPhotoIndex, hasPendingBefore } from './doc-photos';
import { MESSAGES } from './messages';

/**
 * The uploads that go straight to the engine with the app's Bearer token, in the foreground:
 *
 *  - a photo for a custom defect row (the device store only holds photos of an item, so it never enters the queue);
 *  - a baked crop and a baked annotation of an existing photo. They never reach the background uploader: that one
 *    answers `UNSUPPORTED_KIND` for anything but a photo or a clip and would mark the row failed for good.
 *
 * The requests are the ones the engine's own routes take (`upload`, `items/:itemId/photos/:photoIndex/crop` and
 * `.../annotation`). A crop or annotation addresses its photo by position, and the position is read from the live
 * document here, by the photo's key: a queued position is a snapshot and goes stale when photos are added or removed.
 */

export type UploadResult = { ok: true; key: string } | { ok: false; error: string };

type PhotoRecord = Extract<PendingMediaRecord, { kind: 'photo' }>;
type CropRecord = Extract<PendingMediaRecord, { kind: 'crop' }>;
type AnnotateRecord = Extract<PendingMediaRecord, { kind: 'annotate' }>;

export interface ForegroundDeps {
  api: Api;
  /**
   * The bytes of a record that is stored on the device. A record listed from the device store carries an empty blob (the
   * bytes stay on disk), so a queued crop or annotation is read back through this. Null when they cannot be read.
   */
  readStoredBlob(pendingId: string): Promise<Blob | null>;
  /**
   * True when the editor's document for this inspection has caught up with the server (`ResultsDocHandle.synced`). The
   * server counts photos in its own stored copy, so a position taken from a document that is ahead of it would land the
   * crop or annotation on another photo.
   */
  isSynced(inspectionId: string): boolean;
}

export interface ForegroundUploads {
  defectPhoto(rec: PhotoRecord): Promise<UploadResult>;
  /** A photo of an item sent straight to the engine: the last resort when the device store cannot keep it. */
  itemPhotoDirect(rec: PhotoRecord): Promise<UploadResult>;
  crop(rec: CropRecord, doc: Y.Doc | null): Promise<UploadResult>;
  annotate(rec: AnnotateRecord, doc: Y.Doc | null): Promise<UploadResult>;
}

const fail = (error: string): UploadResult => ({ ok: false, error });

const FILE_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
};

/** What a non-success answer is told to the person as. The server's own text is never shown for an upload. */
function refusal(status: number): string {
  if (status === 413) return MESSAGES.photoTooLarge;
  if (status === 403) return MESSAGES.forbidden;
  return MESSAGES.photoUploadFailed;
}

/** The key the answer names under `field`, or the sentence for why there is none. */
function keyOf(outcome: ApiOutcome, field: string): UploadResult {
  if (outcome.kind === 'problem') return fail(problemResult(outcome.problem).error ?? MESSAGES.requestFailed);
  if (!isSuccess(outcome.status)) return fail(refusal(outcome.status));
  const key = bodyData(outcome.json)?.[field];
  return typeof key === 'string' && key !== '' ? { ok: true, key } : fail(MESSAGES.unreadableAnswer);
}

async function bytesOf(deps: ForegroundDeps, rec: PendingMediaRecord): Promise<Blob | null> {
  if (rec.blob.size > 0) return rec.blob;
  const stored = await deps.readStoredBlob(rec.pendingId);
  return stored !== null && stored.size > 0 ? stored : null;
}

function addFile(form: FormData, field: string, blob: Blob, name: string): void {
  form.append(field, blob, name);
}

/** A name that cannot be one path segment is refused before any request; anything else is the caller's to handle. */
async function safely(work: () => Promise<UploadResult>): Promise<UploadResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RangeError) return fail(MESSAGES.invalidValue);
    throw error;
  }
}

export function createForegroundUploads(deps: ForegroundDeps): ForegroundUploads {
  /** The photo's current position, or the sentence for why there is none. Nothing is sent without one. */
  function positionOf(doc: Y.Doc | null, inspectionId: string, meta: { findingKey: string; photoKey: string }): number | string {
    if (doc === null) return MESSAGES.photoGone;
    const index = findPhotoIndex(doc, meta.findingKey, meta.photoKey);
    if (index < 0) return MESSAGES.photoGone;
    // The position is only meaningful to the server when the server's copy has the same photos before this one.
    if (!deps.isSynced(inspectionId) || hasPendingBefore(doc, meta.findingKey, index)) return MESSAGES.waitForSync;
    return index;
  }

  /** One photo as a multipart request to the engine's upload route; `fields` say where it belongs. */
  async function sendPhotoForm(rec: PhotoRecord, fields: Record<string, string>): Promise<UploadResult> {
    const blob = await bytesOf(deps, rec);
    if (blob === null) return fail(MESSAGES.photoNotPrepared);
    if (blob.size > MAX_MEDIA_BYTES) return fail(MESSAGES.photoTooLarge);
    const type = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
    if (!Object.hasOwn(PHOTO_CONTENT_TYPES, type)) return fail(MESSAGES.photoTypeUnsupported);
    const form = new FormData();
    addFile(form, 'file', blob, `photo.${FILE_EXTENSION[type] ?? 'jpg'}`);
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    // One id per photo: a repeat of a request whose answer was lost gets the first answer back, not a second file.
    const outcome = await deps.api.send({ method: 'POST', path: apiPath(rec.inspectionId, 'upload'), form, idempotencyKey: rec.pendingId });
    return keyOf(outcome, 'key');
  }

  async function defectPhoto(rec: PhotoRecord): Promise<UploadResult> {
    if (rec.meta.targetType !== 'defect') return fail(MESSAGES.invalidValue);
    return sendPhotoForm(rec, { itemId: rec.meta.itemId, targetType: 'defect', customId: rec.meta.customId });
  }

  async function itemPhotoDirect(rec: PhotoRecord): Promise<UploadResult> {
    if (rec.meta.targetType === 'defect') return fail(MESSAGES.invalidValue);
    return sendPhotoForm(rec, { itemId: rec.meta.itemId });
  }

  async function crop(rec: CropRecord, doc: Y.Doc | null): Promise<UploadResult> {
    const index = positionOf(doc, rec.inspectionId, rec.meta);
    if (typeof index === 'string') return fail(index);
    const blob = await bytesOf(deps, rec);
    if (blob === null) return fail(MESSAGES.photoNotPrepared);
    if (blob.size > MAX_MEDIA_BYTES) return fail(MESSAGES.photoTooLarge);
    const form = new FormData();
    addFile(form, 'image', blob, 'cropped.jpg');
    form.append('crop', JSON.stringify(rec.meta.crop));
    if (rec.meta.sectionId) form.append('sectionId', rec.meta.sectionId);
    const path = apiPath(rec.inspectionId, 'items', rec.meta.itemId, 'photos', String(index), 'crop');
    return keyOf(await deps.api.send({ method: 'POST', path, form }), 'croppedKey');
  }

  async function annotate(rec: AnnotateRecord, doc: Y.Doc | null): Promise<UploadResult> {
    const index = positionOf(doc, rec.inspectionId, rec.meta);
    if (typeof index === 'string') return fail(index);
    const blob = await bytesOf(deps, rec);
    if (blob === null) return fail(MESSAGES.photoNotPrepared);
    if (blob.size > MAX_MEDIA_BYTES) return fail(MESSAGES.photoTooLarge);
    const form = new FormData();
    addFile(form, 'image', blob, 'annotated.png');
    form.append('nodes', rec.meta.nodesJson);
    if (rec.meta.sectionId) form.append('sectionId', rec.meta.sectionId);
    const path = apiPath(rec.inspectionId, 'items', rec.meta.itemId, 'photos', String(index), 'annotation');
    return keyOf(await deps.api.send({ method: 'POST', path, form }), 'annotatedKey');
  }

  return {
    defectPhoto: (rec) => safely(() => defectPhoto(rec)),
    itemPhotoDirect: (rec) => safely(() => itemPhotoDirect(rec)),
    crop: (rec, doc) => safely(() => crop(rec, doc)),
    annotate: (rec, doc) => safely(() => annotate(rec, doc)),
  };
}
