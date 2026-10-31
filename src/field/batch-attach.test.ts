import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { resolvePendingInDoc } from '../media/pending-doc';
import { photosOf, seedPhotos } from './test-support/doc-seed';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';

/**
 * Batch-attach check. It models the editor's batch hook (`usePhotoBatchUpload`: four workers over the app's uploader,
 * then `attachPhotoBatch`: one `addPhotoToItem` per returned key AFTER the whole batch settled, which upserts by `key` and
 * pushes at the end, then `findings.orderPhotoBatch`) on top of the app's real uploader, store, background uploader and
 * pending-entry code.
 *
 * THIS IS A MODEL. field-ui 0.6.1 does not export `orderPhotoBatch`, `attachPhotoBatch` or `usePhotoBatchUpload`, so
 * `orderPhotoBatch` below is a hand copy of `src/shared/photo-batch-order.ts` of 0.6.1. The version pin at the bottom forces a
 * re-read of that function whenever the package changes.
 */
const FK = '_default:s1:i1';
const CONCURRENCY = 4;

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;
type Named = { key: string } | { pendingId: string };

async function runBatch(w: UploaderWorld, records: Photo[]): Promise<{ keys: string[]; results: Array<{ ok: boolean; kept?: boolean; key?: string }> }> {
  const uploader = w.factory(INSPECTION, w.doc);
  const results: Array<{ ok: boolean; kept?: boolean; key?: string }> = new Array(records.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const rec = records[index];
      if (rec === undefined) return;
      const out = await uploader.upload(rec);
      results[index] = out.ok ? { ok: true, key: out.key } : { ok: false, kept: out.kept === true };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, () => worker()));
  return { keys: results.flatMap((r) => (r.ok && r.key !== undefined ? [r.key] : [])), results };
}

const itemPhotos = (doc: Y.Doc): Y.Array<unknown> => (doc.getMap<unknown>('results').get(FK) as Y.Map<unknown>).get('photos') as Y.Array<unknown>;

/** `addPhotoToItem` of the editor package: upsert by `key`, at the end. */
function attach(doc: Y.Doc, keys: string[]): void {
  const photos = itemPhotos(doc);
  for (const key of keys) {
    doc.transact(() => {
      const existing = photos.toArray().find((el) => el instanceof Y.Map && el.get('key') === key);
      if (existing === undefined) {
        const el = new Y.Map<unknown>();
        el.set('key', key);
        photos.push([el]);
      }
    });
  }
}

/** Hand copy of field-ui 0.6.1 `orderPhotoBatch`: put the named entries into the slots they already occupy, in selection order. */
function orderPhotoBatch(doc: Y.Doc, selection: Named[]): void {
  const arr = itemPhotos(doc);
  const matches = (el: Y.Map<unknown>, n: Named): boolean => ('key' in n ? el.get('key') === n.key : n.pendingId !== '' && el.get('pendingId') === n.pendingId);
  const elements: Y.Map<unknown>[] = [];
  const slots: number[] = [];
  for (const name of selection) {
    for (let i = 0; i < arr.length; i++) {
      const el = arr.get(i);
      if (!(el instanceof Y.Map) || slots.includes(i) || !matches(el, name)) continue;
      slots.push(i);
      elements.push(el);
      break;
    }
  }
  slots.sort((x, y) => x - y);
  const moves = slots.filter((slot, n) => arr.get(slot) !== elements[n]);
  if (moves.length === 0) return;
  doc.transact(() => {
    const copies = new Map<number, Record<string, unknown>>();
    for (const slot of moves) copies.set(slot, (elements[slots.indexOf(slot)] as Y.Map<unknown>).toJSON() as Record<string, unknown>);
    for (const slot of moves) {
      const el = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(copies.get(slot) as Record<string, unknown>)) if (v !== undefined) el.set(k, v);
      arr.delete(slot, 1);
      arr.insert(slot, [el]);
    }
  });
}

/** `attachPhotoBatch` of 0.6.1: attach the keys, then order the whole selection (successes by key, kept ones by pendingId). */
function attachBatch(doc: Y.Doc, batch: { keys: string[]; results: Array<{ ok: boolean; kept?: boolean; key?: string }> }, records: Photo[]): void {
  attach(doc, batch.keys);
  orderPhotoBatch(
    doc,
    batch.results.flatMap((r, i): Named[] => (r.ok && r.key !== undefined ? [{ key: r.key }] : r.kept === true ? [{ pendingId: (records[i] as Photo).pendingId }] : [])),
  );
}

const records = (n: number): Photo[] => Array.from({ length: n }, (_, i) => ({ ...photoRecord(`batch-${i + 1}`, { seed: i + 10 }) }));

describe('a five-photo selection', () => {
  it('adds five entries when every upload succeeds', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    const recs = records(5);
    attachBatch(w.doc, await runBatch(w, recs), recs);
    expect(photosOf(w.doc, FK)).toHaveLength(5);
  });
});

describe('a selection where some uploads fail and are kept', () => {
  const idOf = (entry: Record<string, unknown>): string => (typeof entry.pendingId === 'string' ? entry.pendingId : String(entry.key).split('/').pop()?.replace(/\.jpg$/, '') ?? '');

  it('keeps every selected photo in SELECTION order, so the first photo stays first', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    // The first photo uploads; the second and third fail on the way (kept, a pending entry is written at once); the rest upload.
    w.plugin.script = [{ kind: 'complete' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'complete' }, { kind: 'complete' }];
    const recs = records(5);
    const batch = await runBatch(w, recs);
    expect(batch.results.filter((r) => r.ok)).toHaveLength(3);
    // Before ordering, the kept entries sit ahead of the late-attached successes (the 0.6.0 defect).
    attach(w.doc, batch.keys);
    expect(photosOf(w.doc, FK).map(idOf)).toEqual(['batch-2', 'batch-3', 'batch-1', 'batch-4', 'batch-5']);
    orderPhotoBatch(w.doc, batch.results.flatMap((r, i): Named[] => (r.ok && r.key !== undefined ? [{ key: r.key }] : [{ pendingId: (recs[i] as Photo).pendingId }])));
    const entries = photosOf(w.doc, FK);
    expect(entries).toHaveLength(5);
    expect(entries.map(idOf)).toEqual(['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5']);
  });

  it('is modelled on field-ui 0.6.1; re-read photo-batch-order and attachPhotoBatch when the version changes', () => {
    const manifest = JSON.parse(readFileSync('node_modules/@inspectorhub/field-ui/package.json', 'utf8')) as { version: string };
    expect(manifest.version, 'field-ui changed: re-read orderPhotoBatch / attachPhotoBatch in its dist and update the model in this file').toBe('0.6.1');
  });
});

describe('the kept photos of a selection are resolved later', () => {
  it('turns each pending entry into its real key in place, so all five stay and nothing is added twice', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    w.plugin.script = [{ kind: 'complete' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'complete' }, { kind: 'complete' }];
    const recs = records(5);
    const batch = await runBatch(w, recs);
    attachBatch(w.doc, batch, recs);
    for (const id of ['batch-2', 'batch-3']) {
      expect(resolvePendingInDoc(w.doc, id, `tenant-1/inspections/${INSPECTION}/photos/${id}.jpg`)).toBe('resolved');
    }
    const entries = photosOf(w.doc, FK);
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => typeof e.key === 'string' && e.key !== '' && e.pendingId === undefined)).toBe(true);
  });
});
