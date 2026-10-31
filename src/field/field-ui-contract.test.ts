import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { appendPendingPhoto, type FieldDataSource, type FieldHostSlots, type FieldUrls, type MediaFileResult, type MediaUploader, type PendingMediaRecord, type PhotoSize } from '@inspectorhub/field-ui';
import type { ReactNode } from 'react';
import { MAX_MEDIA_BYTES } from '../media/media-types';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { appendPendingInDoc } from '../media/pending-doc-append';
import { photosOf } from './test-support/doc-seed';
import { reply, scriptedApi } from './test-support/scripted-api';
import { world } from './test-support/data-source-world';
import { createUploaderWorld } from './test-support/uploader-world';
import { createPhotoUrls, createMemoryPhotoIndex } from './photo-urls';
import type { PhotoCache } from './photo-cache';

/**
 * The host-facing surface of @inspectorhub/field-ui that this app depends on, pinned in one place so that an upgrade of
 * the package fails here, loudly, instead of in a device test.
 *
 * Two kinds of check. The `Assert<...>` aliases below are COMPILE-TIME: `npm run typecheck` fails when the shipped types
 * drift from what the app's adapters are written against. The `it` blocks are RUNTIME: they run the app's real adapters
 * and compare them with what the package's own code does.
 *
 * What this does NOT prove: it never mounts the editor, so it cannot show that the editor still CALLS these adapters the
 * way it did (when it asks for `thumb`, how it words a refusal on screen). `photoRefusal` is internal to the package and
 * not exported; its limits (10 MiB, the sniffed image types) are observable here only through the app's own refusal.
 */

// ── compile-time assertions ─────────────────────────────────────────────────────────────────────────────────────────
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type PhotoSizeIsThreeValues = Assert<Equal<PhotoSize, 'thumb' | 'view' | 'original'>>;
export type PhotoUrlShape = Assert<Equal<FieldUrls['photo'], (inspectionId: string, key: string, size?: PhotoSize) => string>>;
export type SubscribeShape = Assert<Equal<FieldUrls['subscribe'], ((listener: () => void) => () => void) | undefined>>;
export type RenderStatusShape = Assert<Equal<FieldHostSlots['renderStatus'], (() => ReactNode) | undefined>>;
export type UploadOutcomeShape = Assert<
  Equal<
    Awaited<ReturnType<MediaUploader['upload']>>,
    { ok: true; key: string; result?: MediaFileResult } | { ok: false; error: string; kept?: true; permanent?: true }
  >
>;
export type FileResultRefusalFields = Assert<Equal<Pick<MediaFileResult, 'kept' | 'permanent'>, { kept?: boolean; permanent?: boolean }>>;
export type PendingEntryFields = Assert<Equal<Extract<PendingMediaRecord, { kind: 'photo' }>['pendingId'], string>>;
// The app's slot object (EditorScreen) must stay a valid FieldHostSlots, and so must one that adds the status slot.
export const appSlots: FieldHostSlots = { humanCheck: 'not-required' };
export const appSlotsWithStatus: FieldHostSlots = { humanCheck: 'not-required', renderStatus: () => null };

const PINNED = '0.6.0';
const REREAD = `@inspectorhub/field-ui is no longer ${PINNED}. Before bumping the pin, re-read: this file, src/field/batch-attach.test.ts (it has its own pin and records a known ordering defect), src/field/uploader-refusal.test.ts, src/media/pending-doc-append.ts against the package's appendPendingPhoto, and src/field/photo-urls.ts against FieldUrls. Then update PINNED here and in batch-attach.test.ts after re-reading.`;

describe('the installed @inspectorhub/field-ui', () => {
  it(`is exactly ${PINNED}`, () => {
    const pkg = JSON.parse(readFileSync(new URL('../../node_modules/@inspectorhub/field-ui/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version, REREAD).toBe(PINNED);
  });
});

describe('urls: photo and subscribe', () => {
  it('createPhotoUrls answers a string for every PhotoSize and for no size at all', () => {
    const photo: FieldUrls['photo'] = createPhotoUrls({ tenantId: 't1', index: createMemoryPhotoIndex() });
    const key = `t1/inspections/${INSPECTION}/photos/p1.jpg`;
    const sizes: Array<PhotoSize | undefined> = ['thumb', 'view', 'original', undefined];
    for (const size of sizes) expect(typeof photo(INSPECTION, key, size)).toBe('string');
  });

  it('with a photo cache the data source forwards the size hint (the original when none) and subscribe returns the cache\'s unsubscribe', async () => {
    const asked: Array<PhotoSize> = [];
    const heard: Array<() => void> = [];
    const unsubscribe = (): void => undefined;
    const photoCache: PhotoCache = {
      lookup: (_inspectionId, _key, size) => (asked.push(size), `https://localhost/_capacitor_file_/${size}.jpg`),
      subscribe: (listener) => (heard.push(listener), unsubscribe),
      warm: () => Promise.resolve(),
      prime: () => Promise.resolve([]),
      sweepOrphans: () => Promise.resolve(0),
      dispose: () => undefined,
      purgeInspection: () => Promise.resolve(),
    };
    const w = await world({ photoCache });
    const source: FieldDataSource = w.source;
    const key = `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`;
    for (const size of ['thumb', 'view', 'original'] as const) expect(source.urls.photo(INSPECTION, key, size)).toContain(size);
    source.urls.photo(INSPECTION, key);
    expect(asked).toEqual(['thumb', 'view', 'original', 'original']);
    const listener = (): void => undefined;
    expect(source.urls.subscribe).toBeDefined();
    expect(source.urls.subscribe?.(listener)).toBe(unsubscribe);
    expect(heard).toEqual([listener]);
  });
});

describe('the upload host contract', () => {
  const sized = (bytes: number): Blob => new Blob([new Uint8Array(bytes).fill(7)], { type: 'image/jpeg' });
  const photo = (pendingId: string, blob: Blob): PendingMediaRecord => ({ ...photoRecord(pendingId), blob });

  it('a file the host refuses outright answers ok:false, a stable code and permanent:true, and is never kept', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(200, { data: { key: 'k' } })) });
    const text = new Blob([new TextEncoder().encode('this is just some text, not a picture at all')], { type: 'text/plain' });
    const outcome = await w.factory(INSPECTION, null).upload(photo('p1', text));
    expect(outcome).toStrictEqual({ ok: false, error: 'UNSUPPORTED_TYPE', permanent: true });
    const big = await w.factory(INSPECTION, null).upload(photo('p2', sized(MAX_MEDIA_BYTES + 1)));
    expect(big).toMatchObject({ ok: false, error: 'TOO_LARGE', permanent: true });
    expect(big).not.toHaveProperty('kept');
  });

  it('the pending entry the app appends is the one the package appends', () => {
    const key = '_default:s1:i1';
    const mine = new Y.Doc();
    const theirs = new Y.Doc();
    expect(appendPendingInDoc(mine, key, 'i1', 'pend-1')).toBe('appended');
    appendPendingPhoto(theirs, key, 'pend-1');
    expect(photosOf(mine, key)).toEqual(photosOf(theirs, key));
    expect(photosOf(theirs, key)).toEqual([{ key: '', pendingUpload: true, pendingId: 'pend-1', pendingKind: 'photo', mediaType: 'photo' }]);
  });
});
