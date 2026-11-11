import { describe, expect, it } from 'vitest';
import type { PhotoDiagnostic } from '../app/diagnostics';
import type { TimerPort } from '../collab/timers';
import { PHOTO_READ_RETRY_DELAY_MS } from '../media/media-types';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { flakyBlob } from '../media/test-support/flaky-blob';
import { MESSAGES } from './messages';
import { createUploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

/** Timers that fire at once and note each delay, plus how many reads the blob had seen when the wait was asked for. */
function recordingTimers(): TimerPort & { delays: number[]; readsAtWait: number[]; probe: { reads: () => number } } {
  const delays: number[] = [];
  const readsAtWait: number[] = [];
  const probe = { reads: () => 0 };
  return {
    delays,
    readsAtWait,
    probe,
    setTimeout: (callback, ms) => {
      delays.push(ms);
      readsAtWait.push(probe.reads());
      callback();
      return 0;
    },
    clearTimeout: () => undefined,
  };
}

async function rig() {
  const timers = recordingTimers();
  const w = await createUploaderWorld({ mediaTimers: timers });
  w.plugin.defaultBehavior = { kind: 'fail' };
  const codes: PhotoDiagnostic[] = [];
  const factory = createUploaderFactory({ ...w.deps, timers, onDiagnostic: (code) => codes.push(code), isOnline: () => true });
  return { w, codes, timers, upload: (blob: Blob) => factory(INSPECTION, null).upload({ ...photoRecord('p1'), blob }) };
}

const rowStates = async (w: Awaited<ReturnType<typeof rig>>['w']) => (await w.world.store.listRows()).map((row) => [row.pendingId, row.state]);

describe('uploader: one transient read failure of the picked photo', () => {
  it('control: the normal path reads the blob once and the sniff slice once, with no wait', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), {});
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect([flaky.wholeReads(), flaky.sliceReads()]).toEqual([1, 1]);
    expect(r.timers.delays).toEqual([]);
    expect(r.codes).toEqual([]);
  });

  it('a whole-blob read that rejects once still keeps the photo, after one wait of the named length', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 1 });
    r.timers.probe.reads = () => flaky.wholeReads();
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.wholeReads()).toBe(2);
    expect(r.timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
    expect(r.timers.readsAtWait).toEqual([1]);
    expect(await rowStates(r.w)).toEqual([['p1', 'failed']]);
    expect(r.codes).toEqual([]);
  });

  it('a whole-blob read that rejects twice is the old refusal and marker, after exactly two attempts and one wait, nothing queued', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 2 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(flaky.wholeReads()).toBe(2);
    expect(r.timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
    expect(await rowStates(r.w)).toEqual([]);
    expect(r.codes).toEqual(['photo_not_kept:store_refused:READ_FAILED:online']);
  });

  it('a permanent refusal is not retried and does not wait (control: the same rig reads a good photo)', async () => {
    const r = await rig();
    const empty = flakyBlob(new Blob([new Uint8Array(0)], { type: 'image/jpeg' }), { whole: 5 });
    await r.upload(empty.blob);
    expect(empty.wholeReads()).toBe(0);
    expect(r.timers.delays).toEqual([]);
    const good = flakyBlob(jpegBlob(), {});
    await r.upload(good.blob);
    expect(good.wholeReads()).toBe(1);
  });

  it('a sniff slice read that rejects once is retried after one wait and the photo is kept', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { slice: 1 });
    r.timers.probe.reads = () => flaky.sliceReads();
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.sliceReads()).toBe(2);
    expect(flaky.wholeReads()).toBe(1);
    expect(r.timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
    expect(r.timers.readsAtWait).toEqual([1]);
  });

  it('a sniff slice read that rejects twice leaves the record as it is (not a drop), after exactly two attempts and one wait', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { slice: 2 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.sliceReads()).toBe(2);
    expect(r.timers.delays).toEqual([PHOTO_READ_RETRY_DELAY_MS]);
  });
});
