import { describe, expect, it } from 'vitest';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { MESSAGES } from './messages';
import { world } from './test-support/data-source-world';

/** The editor's publish, through the real data source: the guard reads the device store and the reconciler's own answer. */
describe('publish through the data source', () => {
  async function withUploadedPhoto() {
    const w = await world();
    await w.store.put(photoRecord('done'));
    await w.store.markState('done', 'uploaded');
    return w;
  }

  it('an uploaded photo that is not attached yet holds the publish back and sends no request', async () => {
    const w = await withUploadedPhoto();
    expect(await w.source.execute(INSPECTION, { type: 'publish' })).toEqual({ ok: false, error: MESSAGES.publishUnsentPhotos });
    expect(w.api.calls).toHaveLength(0);
  });

  it('control: once the reconciler reports it as having no place in the document, the publish is sent', async () => {
    const w = await withUploadedPhoto();
    w.unreferenced.add('done');
    expect((await w.source.execute(INSPECTION, { type: 'publish' })).ok).toBe(true);
    expect(w.api.calls.map((c) => c.path)).toContain(`/api/inspections/${INSPECTION}/publish`);
  });
});
