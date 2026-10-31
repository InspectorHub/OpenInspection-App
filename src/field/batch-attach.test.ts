import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { resolvePendingInDoc } from '../media/pending-doc';
import { photosOf, seedPhotos } from './test-support/doc-seed';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';

/**
 * Reproduction harness for two defects seen on a real device: a five-photo selection that added three, and a cover that
 * moved. It models the editor's batch hook (`usePhotoBatchUpload`: four workers over the app's uploader, one attach per
 * returned key AFTER the whole batch settled, by `appendPhoto`, which upserts by `key`) on top of the app's real uploader,
 * store, background uploader and pending-entry code.
 */
const FK = '_default:s1:i1';
const CONCURRENCY = 4;

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

async function runBatch(w: UploaderWorld, records: Photo[]): Promise<{ keys: string[]; results: Array<{ ok: boolean; key?: string }> }> {
  const uploader = w.factory(INSPECTION, w.doc);
  const results: Array<{ ok: boolean; key?: string }> = new Array(records.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const rec = records[index];
      if (rec === undefined) return;
      const out = await uploader.upload(rec);
      results[index] = out.ok ? { ok: true, key: out.key } : { ok: false };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, () => worker()));
  return { keys: results.flatMap((r) => (r.ok && r.key !== undefined ? [r.key] : [])), results };
}

/** `appendPhoto` of the editor package: upsert by `key`. */
function attach(doc: Y.Doc, keys: string[]): void {
  const item = doc.getMap<unknown>('results').get(FK) as Y.Map<unknown>;
  const photos = item.get('photos') as Y.Array<unknown>;
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

const records = (n: number): Photo[] => Array.from({ length: n }, (_, i) => ({ ...photoRecord(`batch-${i + 1}`, { seed: i + 10 }) }));

describe('a five-photo selection', () => {
  it('adds five entries when every upload succeeds', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    const { keys } = await runBatch(w, records(5));
    attach(w.doc, keys);
    expect(photosOf(w.doc, FK)).toHaveLength(5);
  });
});

describe('a selection where some uploads fail and are kept', () => {
  const idOf = (entry: Record<string, unknown>): string => (typeof entry.pendingId === 'string' ? entry.pendingId : String(entry.key).split('/').pop()?.replace(/\.jpg$/, '') ?? '');

  // KNOWN DEFECT (reproduced 2026-10-31, not fixed): the successes attach in selection order among themselves, but the app
  // writes the pending entry of a KEPT photo into the document immediately, while the batch runs, and the editor attaches the
  // keys of the photos that uploaded only after the whole batch settled (`findings.addPhotoToItem` -> `appendPhoto`, which pushes
  // at the end). So the kept entries sit ahead of the later-attached successes: photo 1 moves from 1st to 3rd.
  // The harness mirrors that field-ui logic. When field-ui changes, re-check both tests below and flip them together:
  // delete the pin test and turn the `it.fails` into a plain `it`.
  it('pins the CURRENT wrong order (flip with the it.fails below when field-ui is fixed)', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    w.plugin.script = [{ kind: 'complete' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'complete' }, { kind: 'complete' }];
    const { keys } = await runBatch(w, records(5));
    attach(w.doc, keys);
    expect(photosOf(w.doc, FK).map(idOf)).toEqual(['batch-2', 'batch-3', 'batch-1', 'batch-4', 'batch-5']);
  });

  it('is modelled on field-ui 0.6.0; re-check this file and its TODO when the version changes', () => {
    const manifest = JSON.parse(readFileSync('node_modules/@inspectorhub/field-ui/package.json', 'utf8')) as { version: string };
    expect(manifest.version, 'field-ui changed: re-check the attach model in this file and flip the known-defect tests if fixed').toBe('0.6.0');
  });

  // TODO(field-ui): attach in selection order, or reserve the entry before the upload.
  it.fails('keeps every selected photo and keeps the selection order, so the first photo stays first', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    // The first photo uploads; the second and third fail on the way (kept, a pending entry is written at once); the rest upload.
    w.plugin.script = [{ kind: 'complete' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'complete' }, { kind: 'complete' }];
    const { keys, results } = await runBatch(w, records(5));
    attach(w.doc, keys);
    const entries = photosOf(w.doc, FK);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(entries).toHaveLength(5);
    expect(entries.map(idOf)).toEqual(['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5']);
  });
});

describe('the kept photos of a selection are resolved later', () => {
  it('turns each pending entry into its real key in place, so all five stay and nothing is added twice', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    w.plugin.script = [{ kind: 'complete' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'complete' }, { kind: 'complete' }];
    const { keys } = await runBatch(w, records(5));
    attach(w.doc, keys);
    for (const id of ['batch-2', 'batch-3']) {
      expect(resolvePendingInDoc(w.doc, id, `tenant-1/inspections/${INSPECTION}/photos/${id}.jpg`)).toBe('resolved');
    }
    const entries = photosOf(w.doc, FK);
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => typeof e.key === 'string' && e.key !== '' && e.pendingId === undefined)).toBe(true);
  });
});
