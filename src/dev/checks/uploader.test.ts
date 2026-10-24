import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaStore } from '../../media/store';
import { createDiagRig, rowsFor } from '../test-support';
import { diagCounts } from './media-rig';
import { KILL_PHOTOS, killClean, killResume, killStart } from './uploader-kill';
import { stopKillSession } from './index';
import { uploaderPhoto } from './uploader-photo';

afterEach(async () => {
  await stopKillSession();
});

describe('uploader-photo', () => {
  it('uploads one tiny photo through the real uploader path and the reconciler, then leaves nothing behind', async () => {
    const rig = await createDiagRig();
    const result = await uploaderPhoto.run(rig.ctx);
    expect(result).toMatchObject({ id: 'uploader-photo', ok: true, status: 'pass' });
    expect(result.detail).toContain('mint=ok native_started=1 event=completed status=200 state=uploaded key_shape=ok reconcile_confirmed=1 row_removed=yes file_removed=yes');
    expect(rig.engine.minted).toHaveLength(1);
    expect(rig.engine.minted[0]?.pendingId).toMatch(/^diag-[0-9a-z]{8}$/);
    expect(rig.world.files.paths()).toEqual([]);
    expect((await diagCounts(createMediaStore({ db: rig.services.db, files: rig.services.files }))).total).toBe(0);
  });

  it('control: a refused upload fails with a fixed code and still removes the row and the file', async () => {
    const rig = await createDiagRig();
    rig.engine.uploadStatuses.push(400);
    const result = await uploaderPhoto.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('upload=failed code=REJECTED retryable=false');
    expect(result.detail).toContain('native_started=1');
    expect(rig.world.files.paths()).toEqual([]);
    expect(await rowsFor(rig.services, 'media', 'inspection_id', 'insp-1')).toBe(0);
  });

  it('control: when the mint fails no native upload starts and the detail says so', async () => {
    const rig = await createDiagRig();
    rig.engine.mintOverride = () => ({ status: 500, headers: new Headers(), text: '', json: undefined, retryAfterMs: null, upgrade: null });
    const result = await uploaderPhoto.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mint=not_reached native_started=0');
  });

  it('shows needs sign-in and needs input instead of failing', async () => {
    const signedOut = await createDiagRig({ signedIn: false });
    expect(await uploaderPhoto.run(signedOut.ctx)).toMatchObject({ ok: false, status: 'needs_sign_in', detail: 'needs sign-in' });
    const noId = await createDiagRig({ inspectionId: '' });
    expect(await uploaderPhoto.run(noId.ctx)).toMatchObject({ ok: false, status: 'needs_input' });
    expect(noId.engine.http.calls).toHaveLength(0);
  });

  it('never uploads a photo that is not a diagnostic one', async () => {
    const rig = await createDiagRig();
    const store = createMediaStore({ db: rig.services.db, files: rig.services.files });
    await store.put({
      pendingId: 'real-photo-1',
      inspectionId: 'insp-1',
      kind: 'photo',
      blob: new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3])], { type: 'image/jpeg' }),
      createdAt: 1,
      meta: { targetType: 'item', findingKey: '_default:s1:i1', itemId: 'i1' },
    });
    const result = await uploaderPhoto.run(rig.ctx);
    expect(result.ok).toBe(true);
    expect(rig.engine.minted.map((m) => m.pendingId)).not.toContain('real-photo-1');
    expect((await store.getRow('real-photo-1'))?.state).toBe('pending');
  });
});

describe('kill test', () => {
  it('stores twenty photos, shows a counter, and after a restart resumes them to completion', async () => {
    const rig = await createDiagRig();
    rig.plugin.defaultBehavior = { kind: 'hang' };
    const started = await killStart.run(rig.ctx);
    expect(started).toMatchObject({ id: 'kill-start', ok: true });
    expect(started.detail).toContain(`photos=${String(KILL_PHOTOS)}`);
    await rig.plugin.whenStarted(1);

    await vi.waitFor(() => {
      expect(rig.timers.pending()).toBeGreaterThan(0);
    });
    rig.timers.fireNext();
    await vi.waitFor(() => {
      expect(rig.emitted.length).toBeGreaterThan(0);
    });
    expect(rig.emitted[0]?.detail).toMatch(/^kill=running done=0 of=20 left=20 pending=\d+ uploading=\d+ uploaded=0 failed=0/);
    expect(rig.emitted[0]?.detail).not.toContain('left=20 pending=20 uploading=0 uploaded=0 failed=0 native_started=0');

    // The process is killed: a fresh page, the same database and files, a working plugin.
    await stopKillSession();
    const restarted = await createDiagRig({ wrap: (s) => ({ ...s, db: rig.services.db, files: rig.services.files }) });
    const resumed = await killResume.run(restarted.ctx);
    expect(resumed).toMatchObject({ id: 'kill-resume', ok: true });
    expect(resumed.detail).toMatch(/^resume before_total=20 before_uploading=1 retried=1 confirmed=20 left=0 pending=0 uploading=0 uploaded=0 failed=0/);
    expect(restarted.world.files.paths()).toEqual([]);
  });

  it('the resume button reports a failed row as a failure', async () => {
    const rig = await createDiagRig();
    rig.plugin.defaultBehavior = { kind: 'hang' };
    await killStart.run(rig.ctx);
    await rig.plugin.whenStarted(1);
    await stopKillSession();
    const restarted = await createDiagRig({ wrap: (s) => ({ ...s, db: rig.services.db, files: rig.services.files }) });
    restarted.plugin.script.push({ kind: 'complete', statusCode: 400 });
    const resumed = await killResume.run(restarted.ctx);
    expect(resumed.ok).toBe(false);
    expect(resumed.detail).toMatch(/failed=1/);
  });

  it('clean removes every diagnostic row and file, and only those', async () => {
    const rig = await createDiagRig();
    rig.plugin.defaultBehavior = { kind: 'hang' };
    await killStart.run(rig.ctx);
    await rig.plugin.whenStarted(1);
    const store = createMediaStore({ db: rig.services.db, files: rig.services.files });
    await store.put({
      pendingId: 'real-photo-2',
      inspectionId: 'insp-1',
      kind: 'photo',
      blob: new Blob([new Uint8Array([0xff, 0xd8, 9])], { type: 'image/jpeg' }),
      createdAt: 1,
      meta: { targetType: 'item', findingKey: '_default:s1:i1', itemId: 'i1' },
    });
    const cleaned = await killClean.run(rig.ctx);
    expect(cleaned).toMatchObject({ ok: true, detail: `removed=${String(KILL_PHOTOS)} left=0` });
    expect(rig.world.files.paths()).toEqual(['media/real-photo-2.jpg']);
    expect(await store.getRow('real-photo-2')).not.toBeNull();
  });

  it('needs a sign-in and an inspection id, and says so', async () => {
    const signedOut = await createDiagRig({ signedIn: false });
    expect(await killStart.run(signedOut.ctx)).toMatchObject({ status: 'needs_sign_in' });
    expect(await killResume.run(signedOut.ctx)).toMatchObject({ status: 'needs_sign_in' });
    const noId = await createDiagRig({ inspectionId: '' });
    expect(await killStart.run(noId.ctx)).toMatchObject({ status: 'needs_input' });
    expect(noId.world.files.paths()).toEqual([]);
  });
});
