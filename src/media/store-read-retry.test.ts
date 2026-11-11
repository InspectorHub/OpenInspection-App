import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES } from './media-types';
import { createMediaStore } from './store';
import { createMediaWorld, jpegBlob, jpegBytes, photoRecord } from './test-support/fakes';
import { flakyBlob } from './test-support/flaky-blob';
import { neverBlocked } from '../test-support/never-blocked';

const ID = '11111111-2222-4333-8444-555555555555';

async function rig() {
  const world = await createMediaWorld();
  const store = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: world.files });
  return { world, store };
}

describe('media store: one transient read failure of the picked blob', () => {
  it('control: the normal path reads the blob exactly once', async () => {
    const { world, store } = await rig();
    const flaky = flakyBlob(jpegBlob(), {});
    await store.put({ ...photoRecord(ID), blob: flaky.blob });
    expect(flaky.wholeReads()).toBe(1);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes());
  });

  it('a read that rejects once is retried once and the photo is stored as usual', async () => {
    const { world, store } = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 1 });
    await store.put({ ...photoRecord(ID), blob: flaky.blob });
    expect(flaky.wholeReads()).toBe(2);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes());
    expect(await store.getRow(ID)).toMatchObject({ pendingId: ID, state: 'pending', attempts: 0 });
  });

  it('a read that rejects twice is READ_FAILED, after exactly two attempts, with no row and no file', async () => {
    const { world, store } = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 2 });
    await expect(store.put({ ...photoRecord(ID), blob: flaky.blob })).rejects.toMatchObject({ code: 'READ_FAILED' });
    expect(flaky.wholeReads()).toBe(2);
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    expect(world.files.paths()).toEqual([]);
  });

  it('a permanent refusal is not retried (positive control: the same store keeps a small photo)', async () => {
    const { store } = await rig();
    const big = flakyBlob(new Blob([new Uint8Array(MAX_MEDIA_BYTES + 1)], { type: 'image/jpeg' }), { whole: 5 });
    await expect(store.put({ ...photoRecord(ID), blob: big.blob })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(big.wholeReads()).toBe(0);
    const small = flakyBlob(jpegBlob(), {});
    await store.put({ ...photoRecord('other-id'), blob: small.blob });
    expect(small.wholeReads()).toBe(1);
  });
});
