import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { AuthError } from '../auth/errors';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { photosOf, seedPhotos } from './test-support/doc-seed';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';

/**
 * A batch whose first upload meets a server that cannot be reached (the OS still says it is online). The request layer
 * throws `server_unreachable` for the mint request. Every photo of the batch must end up in the results document, as a
 * pending entry, and must be uploaded once the server is back.
 */
const FK = '_default:s1:i1';
type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;
const records = (n: number): Photo[] => Array.from({ length: n }, (_, i) => ({ ...photoRecord(`batch-${i + 1}`, { seed: i + 10 }) }));

/** The editor's batch hook: four workers over the uploader. */
async function runBatch(w: UploaderWorld, recs: Photo[]) {
  const uploader = w.factory(INSPECTION, w.doc);
  const results = new Array<Awaited<ReturnType<typeof uploader.upload>>>(recs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const rec = recs[index];
      if (rec === undefined) return;
      results[index] = await uploader.upload(rec);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, recs.length) }, () => worker()));
  return results;
}

/** Every mint request meets an unreachable server (the request layer throws), until `mintOverride` is cleared. */
const unreachable = (w: UploaderWorld): void => {
  w.world.engine.mintOverride = () => {
    throw new AuthError('server_unreachable');
  };
};

describe('a batch while the server is unreachable', () => {
  it('keeps every photo as a pending entry with its local row, and uploads all of them once the server is back', async () => {
    const w = await createUploaderWorld();
    seedPhotos(w.doc, FK, []);
    unreachable(w);
    const results = await runBatch(w, records(3));
    expect(results.map((r) => !r.ok && r.kept === true)).toEqual([true, true, true]);
    expect(photosOf(w.doc, FK).map((e) => e.pendingId)).toEqual(['batch-1', 'batch-2', 'batch-3']);
    expect((await w.world.store.listRows()).map((r) => r.pendingId).sort()).toEqual(['batch-1', 'batch-2', 'batch-3']);

    w.world.engine.mintOverride = null;
    for (const id of ['batch-1', 'batch-2', 'batch-3']) await w.native.retry(id);
    const sent = await Promise.all(['batch-1', 'batch-2', 'batch-3'].map((id) => w.native.uploadDetailed({ pendingId: id, inspectionId: INSPECTION })));
    expect(sent.map((o) => o.ok)).toEqual([true, true, true]);
    expect(w.world.engine.objects.size).toBe(3);
  });
});
