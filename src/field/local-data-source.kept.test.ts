import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { describe, expect, it } from 'vitest';
import type { ManualTimers } from '../collab/test-support/manual-timers';
import { defectPhotoRecord, INSPECTION, photoRecord } from '../media/test-support/fakes';
import { KEPT_WINDOW_MS } from './kept-notice';
import { MESSAGES, photosKeptMessage } from './messages';
import { photosOf } from './test-support/doc-seed';
import { world, type World } from './test-support/data-source-world';
import type { LocalStack } from './local-data-source';

const FK = '_default:s1:i1';
const photo = (pendingId: string): PendingMediaRecord => photoRecord(pendingId) as PendingMediaRecord;
const failing = { uploadDetailed: () => Promise.resolve({ ok: false as const, code: 'NETWORK' as const, retryable: true, retryAfterMs: null, halt: false }) };
const refusing = { uploadDetailed: () => Promise.resolve({ ok: false as const, code: 'NOT_FOUND' as const, retryable: false, retryAfterMs: null, halt: false }) };

async function failingWorld(over: { canEdit?: () => boolean; serverTooOld?: () => boolean; uploader?: LocalStack['uploader'] } = {}): Promise<{ base: World; w: World; timers: ManualTimers }> {
  const base = await world();
  const { canEdit, serverTooOld, uploader } = over;
  const w = await world({
    ...(canEdit === undefined ? {} : { canEdit }),
    stack: { ...base.stack, uploader: uploader ?? failing, ...(serverTooOld === undefined ? {} : { serverTooOld }) },
  });
  return { base, w, timers: w.deps.timers as ManualTimers };
}

const entries = (w: World) => w.stack.withDoc(INSPECTION, (doc) => photosOf(doc, FK));
const kept = (w: World, id: string) => w.source.media.uploader(INSPECTION, null).upload(photo(id));
const keptDefect = (w: World, id: string) => w.source.media.uploader(INSPECTION, null).upload(defectPhotoRecord(id) as PendingMediaRecord);
const toasts = (w: World): string[] => w.notes.map(([message]) => message);

describe('the notice for photos kept after a failed upload', () => {
  it('four concurrent failures give ONE notice with the count (control: one failure is the singular sentence)', async () => {
    const { w, timers } = await failingWorld();
    await Promise.all(['p1', 'p2', 'p3', 'p4'].map((id) => kept(w, id)));
    expect(toasts(w)).toEqual([]);
    timers.fireWithDelay(KEPT_WINDOW_MS);
    expect(w.notes).toEqual([[photosKeptMessage('item', 4), 'info']]);
    expect(photosKeptMessage('item', 4)).toContain('4 photos');
    expect(timers.requested().filter((ms) => ms === KEPT_WINDOW_MS)).toHaveLength(1);

    const one = await failingWorld();
    await kept(one.w, 'q1');
    one.timers.fireWithDelay(KEPT_WINDOW_MS);
    expect(one.w.notes).toEqual([[MESSAGES.photoKept, 'info']]);
  });

  it('the next window starts fresh after the notice was shown', async () => {
    const { w, timers } = await failingWorld();
    await kept(w, 'p1');
    timers.fireWithDelay(KEPT_WINDOW_MS);
    await Promise.all([kept(w, 'p2'), kept(w, 'p3')]);
    timers.fireWithDelay(KEPT_WINDOW_MS);
    expect(toasts(w)).toEqual([MESSAGES.photoKept, photosKeptMessage('item', 2)]);
  });

  it('the sentence is neutral and truthful: saved on this device, not the failure sentence, no promise of an automatic upload', () => {
    expect(MESSAGES.photoKept).toBe('The photo is saved on this device but has not been uploaded yet.');
    expect(MESSAGES.photoKept).not.toBe(MESSAGES.photoUploadFailed);
    expect(MESSAGES.photoKept).not.toMatch(/automatic|will upload|try again|could not/i);
    expect(photosKeptMessage('item', 3)).not.toMatch(/automatic|will upload|try again|could not/i);
    expect(MESSAGES.photoKeptDefect).toContain('defect');
  });

  it('a failure that keeps nothing gives no kept notice (control: it still answers the failure)', async () => {
    const { w, timers } = await failingWorld({ uploader: refusing });
    expect(await kept(w, 'p1')).toStrictEqual({ ok: false, error: MESSAGES.photoUploadFailed });
    expect(timers.requested().filter((ms) => ms === KEPT_WINDOW_MS)).toHaveLength(0);
    expect(toasts(w)).toEqual([]);
  });

  it('a success gives no kept notice', async () => {
    const w = await world();
    expect((await kept(w, 'p1')).ok).toBe(true);
    expect((w.deps.timers as ManualTimers).requested()).not.toContain(KEPT_WINDOW_MS);
    expect(toasts(w)).toEqual([]);
  });

  it('a notice sink that throws changes nothing about the answer and is reported', async () => {
    const errors: unknown[] = [];
    const base = await world();
    const w = await world({
      stack: { ...base.stack, uploader: failing },
      notify: () => {
        throw new Error('toast host gone');
      },
      onError: (e) => void errors.push(e),
    });
    expect((await kept(w, 'p1')).ok).toBe(false);
    (w.deps.timers as ManualTimers).fireWithDelay(KEPT_WINDOW_MS);
    expect(errors).toHaveLength(1);
  });
});

describe('the notice for a kept defect photo', () => {
  it('defect photos are counted apart from item photos and say the defect sentence (control: item photos in the same window keep the item sentence)', async () => {
    const { w, timers } = await failingWorld();
    await Promise.all([keptDefect(w, 'd1'), keptDefect(w, 'd2'), kept(w, 'p1')]);
    timers.fireWithDelay(KEPT_WINDOW_MS);
    timers.fireWithDelay(KEPT_WINDOW_MS);
    expect(toasts(w).sort()).toEqual([MESSAGES.photoKept, photosKeptMessage('defect', 2)].sort());
    expect(photosKeptMessage('defect', 2)).not.toBe(photosKeptMessage('item', 2));
  });

  it('a kept defect photo leaves a row and NO document entry', async () => {
    const { base, w } = await failingWorld();
    expect(await keptDefect(w, 'd1')).toStrictEqual({ ok: false, error: MESSAGES.unreachable, kept: true });
    expect((await base.store.listRows()).map((r) => r.pendingId)).toEqual(['d1']);
    expect(await entries(base)).toEqual([]);
    expect(w.api.calls).toHaveLength(0);
  });
});

describe('a server too old still keeps an item photo and a defect photo; editing turned off still refuses', () => {
  it('too old: a defect photo is kept like an item photo (a row, no entry, kept answer naming the server) and nothing goes to the old server', async () => {
    const { base, w } = await failingWorld({ serverTooOld: () => true });
    const result = await keptDefect(w, 'd1');
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.serverTooOld, kept: true });
    expect((await base.store.listRows()).map((r) => r.pendingId)).toEqual(['d1']);
    expect(await entries(base)).toEqual([]);
    expect(w.api.calls).toHaveLength(0);
    // Control: an item photo beside it also gets its entry.
    expect(await kept(w, 'p1')).toMatchObject({ kept: true });
    expect((await entries(base)).map((e) => e.pendingId)).toEqual(['p1']);
  });

  it('too old: the row, the document entry and the kept answer, saying the server is too old', async () => {
    const { base, w } = await failingWorld({ serverTooOld: () => true });
    const result = await kept(w, 'p1');
    expect(result).toStrictEqual({ ok: false, error: MESSAGES.serverTooOld, kept: true });
    expect((await base.store.listRows()).map((r) => r.pendingId)).toEqual(['p1']);
    expect((await entries(base)).map((e) => e.pendingId)).toEqual(['p1']);
  });

  it('control: editing turned off (even with a server too old) refuses and stores nothing', async () => {
    const { base, w, timers } = await failingWorld({ canEdit: () => false, serverTooOld: () => true });
    expect(await kept(w, 'p1')).toStrictEqual({ ok: false, error: MESSAGES.editingOff });
    expect(await base.store.listRows()).toEqual([]);
    expect(await entries(base)).toEqual([]);
    expect(timers.requested()).not.toContain(KEPT_WINDOW_MS);
  });
});
