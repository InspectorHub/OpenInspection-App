import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { describe, expect, it } from 'vitest';
import type { PhotoDiagnostic } from '../app/diagnostics';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { unreadableBlob } from '../media/test-support/unreadable-blob';
import { createKeptNotice, createUnreadableNotice, KEPT_WINDOW_MS } from './kept-notice';
import { MESSAGES } from './messages';
import { world } from './test-support/data-source-world';
import { createUploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

const photo = (pendingId: string, blob: Blob): PendingMediaRecord => ({ ...photoRecord(pendingId), blob }) as PendingMediaRecord;

describe('a picked photo that cannot be read', () => {
  async function rig() {
    const w = await createUploaderWorld();
    const unreadable: string[] = [];
    const codes: PhotoDiagnostic[] = [];
    const factory = createUploaderFactory({ ...w.deps, onUnreadable: () => unreadable.push(INSPECTION), onDiagnostic: (c) => codes.push(c), isOnline: () => true });
    return { w, unreadable, codes, upload: (rec: PendingMediaRecord) => factory(INSPECTION, null).upload(rec) };
  }

  it('is reported once, keeps the diagnostic code, and stores nothing', async () => {
    const r = await rig();
    const result = await r.upload(photo('p1', unreadableBlob()));
    expect(result.ok).toBe(false);
    expect(r.unreadable).toEqual([INSPECTION]);
    expect(r.codes).toEqual(['photo_not_kept:store_refused:READ_FAILED:online']);
    expect(await r.w.world.store.listRows()).toEqual([]);
  });

  it('an empty file is told the same way', async () => {
    const r = await rig();
    await r.upload(photo('p1', new Blob([], { type: 'image/jpeg' })));
    expect(r.unreadable).toEqual([INSPECTION]);
  });

  it('control: a readable photo is not reported', async () => {
    const r = await rig();
    await r.upload(photo('p1', jpegBlob()));
    expect(r.unreadable).toEqual([]);
    expect(r.codes).toEqual([]);
  });
});

describe('the notice for an unreadable photo', () => {
  it('shows one sentence for a burst, then again after the window', () => {
    const timers = createManualTimers();
    const said: string[] = [];
    const notice = createUnreadableNotice({ timers, say: (m) => said.push(m) });
    notice();
    notice();
    expect(said).toEqual([MESSAGES.photoUnreadable]);
    timers.fireWithDelay(KEPT_WINDOW_MS);
    notice();
    expect(said).toEqual([MESSAGES.photoUnreadable, MESSAGES.photoUnreadable]);
  });

  it('says plainly that the photo could not be read and to pick it again', () => {
    expect(MESSAGES.photoUnreadable).toBe('That photo could not be read. Pick it again.');
  });

  it('control: the kept notice is untouched', () => {
    const timers = createManualTimers();
    const said: string[] = [];
    createKeptNotice({ timers, say: (m) => said.push(m) })('i', 'item');
    expect(said).toEqual([]);
  });
});

describe('through the field data source', () => {
  const upload = (w: Awaited<ReturnType<typeof world>>, blob: Blob) => w.source.media.uploader(INSPECTION, null).upload(photo('p1', blob));

  it('an unreadable photo reaches the screen as an error toast', async () => {
    const w = await world();
    await upload(w, unreadableBlob());
    expect(w.notes).toEqual([[MESSAGES.photoUnreadable, 'error']]);
  });

  it('control: a readable photo gives no such toast', async () => {
    const w = await world();
    expect((await upload(w, jpegBlob())).ok).toBe(true);
    expect(w.notes).toEqual([]);
  });
});
