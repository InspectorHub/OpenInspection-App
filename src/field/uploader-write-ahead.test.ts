import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MediaError } from '../media/errors';
import { resolvePendingInDoc } from '../media/pending-doc';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { MESSAGES } from './messages';
import { photosOf, removePhotos } from './test-support/doc-seed';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

/**
 * A photo of an item must be named in the inspection document from the moment its bytes are on the device, not only after
 * the upload has answered. Before that, a process killed while the upload was out left three things that did not meet: the
 * row on the device, the file on the server (the background upload went on and finished after the restart) and NO entry in the
 * document, so the editor never showed the photo and the settings page could only offer to remove it.
 */

const FK = '_default:s1:i1';
const keyFor = (pendingId: string): string => `tenant-1/inspections/${INSPECTION}/photos/${pendingId}.jpg`;
const PENDING = (pendingId: string) => ({ key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo' });

const rowIds = async (w: UploaderWorld): Promise<string[]> => (await w.world.store.listRows()).map((row) => row.pendingId);
const ticks = async (count = 20): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * What the editor does with a successful key (`appendPhoto` of the editor package): the entry with that key is merged, and
 * only when there is none is a new one added. Mirrored here because the package does not export it.
 */
function editorAttaches(doc: Y.Doc, findingKey: string, key: string): void {
  const item = doc.getMap<unknown>('results').get(findingKey);
  const photos = item instanceof Y.Map ? item.get('photos') : undefined;
  if (!(photos instanceof Y.Array)) throw new Error('no photos array');
  const existing = photos.toArray().find((entry) => entry instanceof Y.Map && entry.get('key') === key);
  if (existing === undefined) {
    const fresh = new Y.Map<unknown>();
    fresh.set('key', key);
    photos.push([fresh]);
  }
}

describe('an item photo is named in the document before its upload starts', () => {
  it('the pending entry is already there when the upload is called', async () => {
    const w = await createUploaderWorld();
    let seen: Record<string, unknown>[] | null = null;
    const factory = createUploaderFactory({
      ...w.deps,
      native: {
        uploadDetailed: (ref, opts) => {
          seen = photosOf(w.doc, FK);
          return w.native.uploadDetailed(ref, opts);
        },
      },
    });
    await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(seen).toEqual([PENDING('p1')]);
  });

  it('a process killed while the upload is out leaves a document that names the photo; after the restart the entry resolves to the key', async () => {
    const w = await createUploaderWorld();
    let calls = 0;
    const hung = createUploaderFactory({
      ...w.deps,
      native: {
        uploadDetailed: () => {
          calls += 1;
          return new Promise(() => undefined);
        },
      },
    });
    void hung(INSPECTION, null).upload(photoRecord('p1'));
    await ticks();
    expect(calls).toBe(1);

    // The process dies here. Only what is stored survives: the row and file on the device, and the document's stored updates.
    expect(await rowIds(w)).toEqual(['p1']);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(w.doc));
    expect(photosOf(restored, FK)).toEqual([PENDING('p1')]);

    // After the restart the background upload finishes and the app's reconciler resolves the entry by its pendingId.
    expect(resolvePendingInDoc(restored, 'p1', keyFor('p1'))).toBe('resolved');
    expect(photosOf(restored, FK).map((entry) => entry.key)).toEqual([keyFor('p1')]);
  });

  it('control: with nothing killed, a success leaves the document holding the key and no pending field, and the editor attaching the same key adds nothing', async () => {
    const w = await createUploaderWorld();
    const result = await w.factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result).toEqual({ ok: true, key: keyFor('p1') });
    expect(photosOf(w.doc, FK)).toEqual([{ key: keyFor('p1'), mediaType: 'photo' }]);
    editorAttaches(w.doc, FK, keyFor('p1'));
    expect(photosOf(w.doc, FK)).toHaveLength(1);
    expect(await rowIds(w)).toEqual([]);
  });

  it('control: a failed upload still answers kept, with exactly one entry (the one written first)', async () => {
    const w = await createUploaderWorld();
    w.plugin.defaultBehavior = { kind: 'fail' };
    const result = await w.factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    expect(await rowIds(w)).toEqual(['p1']);
    expect(w.docCalls).toEqual([INSPECTION]);
  });
});

describe('what happens when the document cannot take the entry first, or loses it', () => {
  it('an entry written first whose swap cannot be made answers kept (the entry still names the photo) and leaves the row for the reconciler, so the editor adds no second entry', async () => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({
      ...w.deps,
      native: {
        uploadDetailed: async (ref, opts) => {
          const done = await w.native.uploadDetailed(ref, opts);
          w.docFailure.error = new MediaError('DOC_BUSY');
          return done;
        },
      },
    });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(await rowIds(w)).toEqual(['p1']);
    expect(photosOf(w.doc, FK)).toEqual([PENDING('p1')]);
    // The reconciler's later swap finishes it.
    w.docFailure.error = null;
    expect(resolvePendingInDoc(w.doc, 'p1', keyFor('p1'))).toBe('resolved');
  });

  it('an inspection that is blocked is not uploaded to at all, and its row is left to the quarantine', async () => {
    const w = await createUploaderWorld();
    w.docFailure.error = new MediaError('BLOCKED');
    const result = await w.factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(w.nativeCalls).toEqual([]);
    expect(await rowIds(w)).toEqual(['p1']);
  });

  it('a document that stays busy does not stop the upload: it falls back to the old way (the editor attaches the key) and the finished row is removed as before', async () => {
    const w = await createUploaderWorld();
    w.docFailure.error = new MediaError('DOC_BUSY');
    let done = false;
    const work = w.factory(INSPECTION, null).upload(photoRecord('p1')).finally(() => {
      done = true;
    });
    for (let i = 0; i < 400 && !done; i += 1) {
      await ticks(1);
      if (!done && w.docTimers.pending() > 0) w.docTimers.fireNext();
    }
    expect(await work).toEqual({ ok: true, key: keyFor('p1') });
    expect(w.nativeCalls).toEqual(['p1']);
    // No entry was written first, so there is nothing to swap or to leave for the reconciler: the key goes to the editor.
    expect(await rowIds(w)).toEqual([]);
  });

  it('a photo the person deletes while it uploads is not brought back by the success: the answer is not ok and nothing is deleted from the device', async () => {
    const w = await createUploaderWorld();
    const factory = createUploaderFactory({
      ...w.deps,
      native: {
        uploadDetailed: (ref, opts) => {
          removePhotos(w.doc, FK, (entry) => entry.pendingId === 'p1');
          return w.native.uploadDetailed(ref, opts);
        },
      },
    });
    const result = await factory(INSPECTION, null).upload(photoRecord('p1'));
    expect(result.ok).toBe(false);
    expect(photosOf(w.doc, FK)).toEqual([]);
    expect(await rowIds(w)).toEqual(['p1']);
  });
});

/**
 * The write-ahead entry is only safe because of one rule of the editor package: when a photo succeeds the editor adds its key with
 * `appendPhoto`, and an entry that already has that key is MERGED, not added again. If that rule ever changed, every photo would
 * appear twice in the report. `appendPhoto` is not exported, so `editorAttaches` above is a copy of it; this test is what keeps the
 * copy honest. It reads the installed package's own code and fails when the version or that code changes, so the person upgrading
 * the package re-reads the rule instead of the copy silently going on passing. When the package exports `appendPhoto`, replace
 * the copy with the export and delete this test.
 */
describe('the editor package rule the write-ahead entry relies on', () => {
  const dist = readFileSync('node_modules/@inspectorhub/field-ui/dist/index.js', 'utf8');

  it('is modelled on field-ui 0.7.0', () => {
    const manifest = JSON.parse(readFileSync('node_modules/@inspectorhub/field-ui/package.json', 'utf8')) as { version: string };
    expect(manifest.version, 'field-ui changed: re-read appendPhoto / upsertElement in its dist, check a photo that is swapped to its key and then attached by key stays ONE entry, and update the copy and this pin').toBe('0.7.0');
  });

  it('attaches a photo by key with upsert: an entry with that key is merged, a new one is pushed only when there is none', () => {
    const attach = /function appendPhoto\(doc, findingKey\d*, photo\) \{[\s\S]*?upsertElement\(getOrCreateArray\(item, "photos"\), "key", \{ \.\.\.photo \}\);/.exec(dist);
    expect(attach, 'appendPhoto no longer upserts by "key"').not.toBeNull();
    const upsert = /function upsertElement\(arr, identityField, entry\) \{[\s\S]*?const existing = findElementByKey\(arr, identityField, identityValue\);\s*if \(existing\) \{\s*assignFields\(existing, entry\);\s*return;\s*\}[\s\S]*?arr\.push\(\[el\]\);/.exec(dist);
    expect(upsert, 'upsertElement no longer merges into an existing element before pushing').not.toBeNull();
  });
});
