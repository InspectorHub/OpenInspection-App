import { describe, expect, it } from 'vitest';
import type { TimerPort } from '../collab/timers';
import { MAX_MEDIA_BYTES, PHOTO_READ_RETRY_DELAY_MS } from './media-types';
import { createMediaStore } from './store';
import { createMediaWorld, jpegBlob, jpegBytes, photoRecord } from './test-support/fakes';
import { flakyBlob } from './test-support/flaky-blob';
import { neverBlocked } from '../test-support/never-blocked';

const ID = '11111111-2222-4333-8444-555555555555';

/** Timers that fire at once and note each delay, plus how many reads of the blob had happened when the wait was asked for. */
function recordingTimers(readsSoFar: () => number): TimerPort & { delays: number[]; readsAtWait: number[] } {
  const delays: number[] = [];
  const readsAtWait: number[] = [];
  return {
    delays,
    readsAtWait,
    setTimeout: (callback, ms) => {
      delays.push(ms);
      readsAtWait.push(readsSoFar());
      callback();
      return 0;
    },
    clearTimeout: () => undefined,
  };
}

async function rig(readsSoFar: () => number = () => 0) {
  const world = await createMediaWorld();
  const timers = recordingTimers(readsSoFar);
  const store = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: world.files, timers });
  return { world, store, timers };
}

describe('media store: one transient read failure of the picked blob', () => {
  it('control: the normal path reads the blob exactly once and does not wait', async () => {
    const flaky = flakyBlob(jpegBlob(), {});
    const { world, store, timers } = await rig(() => flaky.wholeReads());
    await store.put({ ...photoRecord(ID), blob: flaky.blob });
    expect(flaky.wholeReads()).toBe(1);
    expect(timers.delays).toEqual([]);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes());
  });

  it('a read that rejects once is retried once, after one wait, and the photo is stored as usual', async () => {
    const flaky = flakyBlob(jpegBlob(), { whole: 1 });
    const { world, store, timers } = await rig(() => flaky.wholeReads());
    await store.put({ ...photoRecord(ID), blob: flaky.blob });
    expect(flaky.wholeReads()).toBe(2);
    // One wait, of the named length, between the failed read and the retry.
    expect(timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
    expect(timers.readsAtWait).toEqual([1]);
    expect(PHOTO_READ_RETRY_DELAY_MS).toBeGreaterThanOrEqual(100);
    expect(PHOTO_READ_RETRY_DELAY_MS).toBeLessThanOrEqual(250);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes());
    expect(await store.getRow(ID)).toMatchObject({ pendingId: ID, state: 'pending', attempts: 0 });
  });

  it('a read that rejects twice is READ_FAILED, after exactly two attempts and one wait, with no row and no file', async () => {
    const flaky = flakyBlob(jpegBlob(), { whole: 2 });
    const { world, store, timers } = await rig(() => flaky.wholeReads());
    await expect(store.put({ ...photoRecord(ID), blob: flaky.blob })).rejects.toMatchObject({ code: 'READ_FAILED' });
    expect(flaky.wholeReads()).toBe(2);
    expect(timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    expect(world.files.paths()).toEqual([]);
  });

  it('a permanent refusal is not retried and does not wait (positive control: the same store keeps a small photo)', async () => {
    const { store, timers } = await rig();
    const big = flakyBlob(new Blob([new Uint8Array(MAX_MEDIA_BYTES + 1)], { type: 'image/jpeg' }), { whole: 5 });
    await expect(store.put({ ...photoRecord(ID), blob: big.blob })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(big.wholeReads()).toBe(0);
    expect(timers.delays).toEqual([]);
    const small = flakyBlob(jpegBlob(), {});
    await store.put({ ...photoRecord('other-id'), blob: small.blob });
    expect(small.wholeReads()).toBe(1);
  });
});
