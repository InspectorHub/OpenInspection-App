import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { describe, expect, it } from 'vitest';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { listOutbox } from '../offline/outbox';
import { MESSAGES } from './messages';
import { world } from './test-support/data-source-world';

const SENTENCE = 'Editing is turned off until you update the app.';

describe('editing turned off by a required update (canEdit false)', () => {
  it('the sentence is fixed and written in MESSAGES', () => {
    expect(MESSAGES.editingOff).toBe(SENTENCE);
  });

  it('execute of any command is refused with the sentence: no request, no queued write (control: allowed, the same commands work)', async () => {
    const off = await world({ canEdit: () => false });
    for (const command of [{ type: 'complete' }, { type: 'sign-inspector', signatureBase64: 'abc' }] as const) {
      expect(await off.source.execute(INSPECTION, command)).toEqual({ ok: false, error: SENTENCE });
    }
    expect(off.api.calls).toHaveLength(0);
    expect(await listOutbox(off.db, {})).toEqual([]);

    const on = await world({ canEdit: () => true });
    expect(await on.source.execute(INSPECTION, { type: 'complete' })).toEqual({ ok: true });
    await on.source.execute(INSPECTION, { type: 'sign-inspector', signatureBase64: 'abc' });
    expect(on.api.calls).toHaveLength(1);
    expect((await listOutbox(on.db, {})).map((row) => row.op)).toEqual(['inspection.complete']);
  });

  it('a data source built without canEdit allows editing', async () => {
    const w = await world();
    expect(await w.source.execute(INSPECTION, { type: 'complete' })).toEqual({ ok: true });
  });

  it('a state that cannot be read is not known, and unknown is allowed', async () => {
    const w = await world({
      canEdit: () => {
        throw new Error('state unreadable');
      },
    });
    expect(await w.source.execute(INSPECTION, { type: 'complete' })).toEqual({ ok: true });
  });

  it('the answer follows the state at each call, not at construction', async () => {
    const gate = { value: true };
    const w = await world({ canEdit: () => gate.value });
    expect(await w.source.execute(INSPECTION, { type: 'complete' })).toEqual({ ok: true });
    gate.value = false;
    expect(await w.source.execute(INSPECTION, { type: 'sign-inspector', signatureBase64: 'abc' })).toEqual({ ok: false, error: SENTENCE });
    gate.value = true;
    await w.source.execute(INSPECTION, { type: 'sign-inspector', signatureBase64: 'abc' });
    expect(w.api.calls).toHaveLength(1);
  });

  it('a photo is refused at the uploader and at the store: nothing written to the device, nothing sent', async () => {
    const off = await world({ canEdit: () => false });
    const uploader = off.source.media.uploader(INSPECTION, null);
    expect(await uploader.upload(photoRecord('p1') as PendingMediaRecord)).toEqual({ ok: false, error: SENTENCE });
    const defect: PendingMediaRecord = { ...photoRecord('p2'), meta: { targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'c1', defectKind: 'custom' } };
    expect(await uploader.upload(defect)).toEqual({ ok: false, error: SENTENCE });
    await expect(off.source.media.store.put(photoRecord('p3') as PendingMediaRecord)).rejects.toThrow(SENTENCE);
    expect(off.nativeCalls).toEqual([]);
    expect(off.api.calls).toHaveLength(0);
    expect(await off.store.listRows()).toEqual([]);

    const on = await world({ canEdit: () => true });
    expect((await on.source.media.uploader(INSPECTION, null).upload(photoRecord('p1') as PendingMediaRecord)).ok).toBe(true);
    await on.source.media.store.put(photoRecord('p3') as PendingMediaRecord);
    expect((await on.store.listRows()).map((r) => r.pendingId)).toEqual(['p3']);
  });

  it('reading stays available: load, the stored photos and the session', async () => {
    const off = await world({ canEdit: () => false });
    await off.store.put(photoRecord('p1'));
    expect((await off.source.load(INSPECTION)).inspection).toBeDefined();
    expect((await off.source.media.store.list(INSPECTION)).map((r) => r.pendingId)).toEqual(['p1']);
    expect(await off.source.media.store.get('p1')).not.toBeNull();
    expect(off.source.session()).toBeDefined();
  });

  it('the queue and the uploader of the stack are not touched: queued writes remain and the stack still sends a stored photo', async () => {
    const w = await world({ canEdit: () => true });
    await w.source.execute(INSPECTION, { type: 'complete' });
    await w.store.put(photoRecord('p1'));
    const queued = (await listOutbox(w.db, {})).length;
    const off = await world({ canEdit: () => false, stack: w.stack });
    await off.source.execute(INSPECTION, { type: 'complete' });
    expect((await listOutbox(w.db, {})).length).toBe(queued);
    expect(queued).toBe(1);
    expect((await w.stack.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: INSPECTION })).ok).toBe(true);
    expect(w.nativeCalls).toContain('p1');
  });
});

describe('a server too old: the editor uploader says so instead of pretending the device is locked', () => {
  const OLD = 'This server is too old for this app. Ask your administrator to update it.';

  it('the sentence is fixed and written in MESSAGES', () => {
    expect(MESSAGES.serverTooOld).toBe(OLD);
  });

  it('refuses a kind that keeps nothing before anything is stored or sent (control: a sufficient server uploads; item photos are kept, see local-data-source.kept.test.ts)', async () => {
    const base = await world();
    const old = await world({ stack: { ...base.stack, serverTooOld: () => true } });
    const uploader = old.source.media.uploader(INSPECTION, null);
    const defect: PendingMediaRecord = { ...photoRecord('p1'), meta: { targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'c1', defectKind: 'custom' } };
    expect(await uploader.upload(defect)).toEqual({ ok: false, error: OLD });
    expect(base.nativeCalls).toEqual([]);
    expect(await base.store.listRows()).toEqual([]);
    const fine = await world({ stack: { ...base.stack, serverTooOld: () => false } });
    expect((await fine.source.media.uploader(INSPECTION, null).upload(photoRecord('p1') as PendingMediaRecord)).ok).toBe(true);
  });

  it('keeps the device-only path: a photo can still be stored on the device', async () => {
    const base = await world();
    const old = await world({ stack: { ...base.stack, serverTooOld: () => true } });
    await old.source.media.store.put(photoRecord('p9') as PendingMediaRecord);
    expect((await base.store.listRows()).map((r) => r.pendingId)).toEqual(['p9']);
  });

  it('editing turned off wins over a server too old when both hold', async () => {
    const base = await world();
    const w = await world({ canEdit: () => false, stack: { ...base.stack, serverTooOld: () => true } });
    expect(await w.source.media.uploader(INSPECTION, null).upload(photoRecord('p1') as PendingMediaRecord)).toEqual({ ok: false, error: 'Editing is turned off until you update the app.' });
  });
});
