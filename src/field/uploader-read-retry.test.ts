import { describe, expect, it } from 'vitest';
import type { PhotoDiagnostic } from '../app/diagnostics';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { flakyBlob } from '../media/test-support/flaky-blob';
import { MESSAGES } from './messages';
import { createUploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

async function rig() {
  const w = await createUploaderWorld();
  w.plugin.defaultBehavior = { kind: 'fail' };
  const codes: PhotoDiagnostic[] = [];
  const factory = createUploaderFactory({ ...w.deps, onDiagnostic: (code) => codes.push(code), isOnline: () => true });
  return { w, codes, upload: (blob: Blob) => factory(INSPECTION, null).upload({ ...photoRecord('p1'), blob }) };
}

const rowStates = async (w: Awaited<ReturnType<typeof rig>>['w']) => (await w.world.store.listRows()).map((row) => [row.pendingId, row.state]);

describe('uploader: one transient read failure of the picked photo', () => {
  it('control: the normal path reads the blob once and the sniff slice once', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), {});
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect([flaky.wholeReads(), flaky.sliceReads()]).toEqual([1, 1]);
    expect(r.codes).toEqual([]);
  });

  it('a whole-blob read that rejects once still keeps the photo, exactly as the normal path does', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 1 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.wholeReads()).toBe(2);
    expect(await rowStates(r.w)).toEqual([['p1', 'failed']]);
    expect(r.codes).toEqual([]);
  });

  it('a whole-blob read that rejects twice is the old refusal and marker, after exactly two attempts, nothing queued', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { whole: 2 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.photoNotPrepared });
    expect(flaky.wholeReads()).toBe(2);
    expect(await rowStates(r.w)).toEqual([]);
    expect(r.codes).toEqual(['photo_not_kept:store_refused:READ_FAILED:online']);
  });

  it('a permanent refusal is not retried (control: the same rig reads a good photo)', async () => {
    const r = await rig();
    const empty = flakyBlob(new Blob([new Uint8Array(0)], { type: 'image/jpeg' }), { whole: 5 });
    await r.upload(empty.blob);
    expect(empty.wholeReads()).toBe(0);
    const good = flakyBlob(jpegBlob(), {});
    await r.upload(good.blob);
    expect(good.wholeReads()).toBe(1);
  });

  it('a sniff slice read that rejects once is retried and the photo is kept', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { slice: 1 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.sliceReads()).toBe(2);
    expect(flaky.wholeReads()).toBe(1);
  });

  it('a sniff slice read that rejects twice leaves the record as it is (not a drop), after exactly two attempts', async () => {
    const r = await rig();
    const flaky = flakyBlob(jpegBlob(), { slice: 2 });
    const result = await r.upload(flaky.blob);
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect(flaky.sliceReads()).toBe(2);
  });
});
