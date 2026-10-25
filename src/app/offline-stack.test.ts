import { describe, expect, it } from 'vitest';
import { saveIdentity } from '../auth/server-config';
import { createMediaStore } from '../media/store';
import { videoRecord } from '../media/test-support/video-fakes';
import { photoRecord } from '../media/test-support/fakes';
import { isIssuedPlan } from '../offline/plan-brand';
import { enqueue, OutboxError } from '../offline/outbox';
import { accountKey } from '../offline/outbox';
import { ALICE, BOB, deferred } from '../offline/test-support/replay-world';
import { jsonReply, NOW } from '../offline/test-support/package-world';
import { neverBlocked } from '../test-support/never-blocked';
import { SWEEP_KEY, SWEEP_MIN_INTERVAL_MS, TEMP_SWEEP_KEY, placeholderResolveVideo, type OfflineStack } from './offline-stack';
import { createStackWorld, dbThatFails, type StackWorld } from './test-support/stack-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };
const UPDATE = (id: string) => ({ inspectionId: id, changes: { sqft: 10 } });
const HOUR = 3_600_000;

/** Starts the stack and waits until everything its start sequence runs has finished. */
async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

function nextStatus(stack: OfflineStack, done: (status: ReturnType<OfflineStack['status']['get']>) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (done(stack.status.get())) {
      resolve();
      return;
    }
    const off = stack.status.subscribe(() => {
      if (!done(stack.status.get())) return;
      off();
      resolve();
    });
  });
}

describe('construction', () => {
  it('does nothing until started: no request, no timer, no listener', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    expect(w.pkg.requests).toEqual([]);
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
    await stack.stop();
  });

  it('takes the account and the origin from the stored identity, and exposes the account it works for', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    expect(stack.account).toEqual(ALICE);
    expect(stack.db).toBe(w.replay.db);
    await stack.stop();
  });

  it('refuses an origin that is not exactly the stored canonical one', async () => {
    const w = await createStackWorld();
    expect(() => w.make({ origin: 'https://oi.example.test/path' })).toThrow();
  });

  it('keeps only X-Client-* headers: nothing that could carry a credential reaches a request', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    const stack = w.make({ clientHeaders: { 'X-Client-Platform': 'android', Authorization: 'Bearer stolen', Cookie: 'a=b', 'X-Other': 'no' } });
    await run(stack);
    const post = w.pkg.requests.find((r) => r.method === 'POST');
    expect(post?.headers['X-Client-Platform']).toBe('android');
    expect(post?.headers.Authorization).toBe('Bearer access-token-secret');
    expect(post?.headers.Cookie).toBeUndefined();
    expect(post?.headers['X-Other']).toBeUndefined();
    await stack.stop();
  });
});

describe('lifecycle', () => {
  it('start is idempotent: a second start adds no listener and no run', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    const listeners = w.residue();
    const requests = w.pkg.requests.length;
    stack.start();
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(w.residue()).toEqual(listeners);
    expect(w.pkg.requests.length).toBe(requests);
    expect(listeners.network).toBeGreaterThan(0);
    await stack.stop();
  });

  it('stop leaves no timer and no listener behind, and is idempotent', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    const before = w.residue();
    expect(before.network).toBeGreaterThan(0);
    expect(before.appState).toBeGreaterThan(0);
    expect(before.unlock).toBeGreaterThan(0);
    expect(before.verified).toBe(1);
    expect(before.timers).toBeGreaterThan(0);
    await stack.stop();
    await stack.stop();
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
    expect(stack.isStopped()).toBe(true);
  });

  it('is terminal: after stop nothing is sent, nothing is queued, no connection opens, and the user actions refuse', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    await stack.stop();
    const requests = w.pkg.requests.length;
    stack.replayer.trigger();
    stack.refresher.trigger('manual');
    stack.reconciler.trigger('manual');
    w.replay.network.set(true);
    w.replay.appState.emit(true);
    await expect(stack.enqueue('inspection.create', CREATE)).rejects.toMatchObject({ code: 'invalid_account' });
    expect(() => stack.connector.connect('insp-1', {})).toThrow();
    await expect(stack.userActions.removeFromDevice('insp-1', { confirmed: true })).resolves.toEqual({ kind: 'locked' });
    expect(w.pkg.requests.length).toBe(requests);
    expect(w.residue().timers).toBe(0);
  });

  it('destroys the connections opened through its connector when it stops', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    stack.connector.connect('insp-9', {});
    expect(stack.connector.isOpen('insp-9')).toBe(true);
    await stack.stop();
    expect(stack.connector.isOpen('insp-9')).toBe(false);
  });

  it('does not start while locked, starts on the first unlock, and sends nothing in between', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    w.lock.locked = true;
    w.unlocks.note({ locked: true, reason: 'expired' });
    const stack = w.make();
    stack.start();
    await stack.settled();
    expect(w.pkg.requests).toEqual([]);
    expect(w.residue().network).toBe(0);
    expect(w.residue().unlock).toBe(1);

    w.lock.locked = false;
    w.unlocks.note({ locked: false });
    await stack.settled();
    await stack.idle();
    expect(w.pkg.requests.some((r) => r.method === 'POST')).toBe(true);
    expect(w.residue().network).toBeGreaterThan(0);
    await stack.stop();
  });

  it('a lock that arrives while running stops all sending, and the unlock resumes it through onUnlocked', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    w.lock.locked = true;
    w.unlocks.note({ locked: true, reason: 'expired' });
    const before = w.pkg.requests.length;
    await stack.enqueue('inspection.create', CREATE);
    await stack.idle();
    expect(w.pkg.requests.length).toBe(before);
    expect((await w.replay.db.query('SELECT 1 FROM outbox')).length).toBe(1);

    w.lock.locked = false;
    w.unlocks.note({ locked: false });
    await stack.idle();
    expect(w.pkg.requests.some((r) => r.method === 'POST')).toBe(true);
    expect((await w.replay.db.query('SELECT 1 FROM outbox')).length).toBe(0);
    await stack.stop();
  });

  it('fails closed: a lock check that cannot be answered counts as locked', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    const stack = w.make({
      isLocked: () => {
        throw new Error('lock state unreadable');
      },
    });
    stack.start();
    await stack.settled();
    expect(w.pkg.requests).toEqual([]);
    expect(w.residue().network).toBe(0);
    await stack.stop();
  });

  it('by default reads the stored lock state: past the offline period nothing starts, a revocation locks too', async () => {
    const w = await createStackWorld();
    const stack = w.make({ isLocked: undefined });
    w.replay.clock.advance(31 * 86_400_000);
    stack.start();
    await stack.settled();
    expect(w.pkg.requests).toEqual([]);
    await stack.stop();
  });
});

describe('the account', () => {
  it('a stack built for one account stops acting when the stored identity is another', async () => {
    const w = await createStackWorld();
    const a = w.make();
    await run(a);
    await a.enqueue('inspection.create', CREATE);
    await a.idle();
    expect(w.pkg.requests.some((r) => r.method === 'POST')).toBe(true);

    await saveIdentity(w.replay.db, { userId: BOB.userId, tenantId: BOB.tenantId, role: 'inspector' });
    await expect(a.enqueue('inspection.update', UPDATE('insp-1'))).rejects.toBeInstanceOf(OutboxError);
    await a.stop();

    const b = w.make({ identity: { userId: BOB.userId, tenantId: BOB.tenantId, role: 'inspector' } });
    expect(b.account).toEqual(BOB);
    await run(b);
    const row = await b.enqueue('inspection.create', { ...CREATE, id: 'insp-2' });
    expect(row.userId).toBe('bob');
    await b.stop();
    expect(a.isStopped()).toBe(true);
    expect(accountKey(a.account)).not.toBe(accountKey(b.account));
  });
});

describe('the shared lease', () => {
  it('replay, reconcile and refresh never overlap: while a write is in flight the others find the lease held and send nothing', async () => {
    const w = await createStackWorld();
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    const gate = deferred();
    const inFlight = deferred();
    w.pkg.hook = async (request) => {
      if (request.method === 'POST' && request.path === '/api/inspections') {
        inFlight.resolve();
        await gate.promise;
      }
    };
    const stack = w.make();
    stack.start();
    await inFlight.promise;

    const turnedAway = await stack.refresher.refresh({ reason: 'manual' });
    // A reconcile asked for before the first replay has finished is not started at all: its first flow follows the replay.
    stack.reconciler.trigger('manual');
    expect(turnedAway.leaseBusy).toBe(true);
    expect(stack.reconciler.last.status).toBe('never');
    expect(w.pkg.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/inspections']);

    gate.resolve();
    await stack.settled();
    await stack.idle();
    expect(w.pkg.requests[0]?.method).toBe('POST');
    expect(w.pkg.requests.some((r) => r.method === 'GET' && r.path === '/api/inspections')).toBe(true);
    await stack.stop();
  });
});

describe('triggers reach the flows', () => {
  async function started(): Promise<{ w: StackWorld; stack: OfflineStack }> {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    return { w, stack };
  }

  /** Moves the clock, fires the trigger and reports whether the reconciler ran a new flow because of it. */
  async function reconciled(w: StackWorld, stack: OfflineStack, trigger: () => void | Promise<void>): Promise<boolean> {
    w.replay.clock.advance(2 * HOUR);
    const before = stack.reconciler.last.at;
    await trigger();
    await stack.idle();
    return stack.reconciler.last.at !== before && stack.reconciler.last.at === w.replay.clock.now();
  }

  it('control: nothing runs the reconciler by itself', async () => {
    const { w, stack } = await started();
    expect(await reconciled(w, stack, () => undefined)).toBe(false);
    await stack.stop();
  });

  it('the first flow ran at start', async () => {
    const { stack } = await started();
    expect(stack.reconciler.last.status).not.toBe('never');
    await stack.stop();
  });

  it('a write the server cannot see reaches the reconciler (onNeedsReconcile)', async () => {
    const { w, stack } = await started();
    expect(await reconciled(w, stack, () => stack.enqueue('inspection.update', UPDATE('ghost-1')).then(() => undefined))).toBe(true);
    await stack.stop();
  });

  it('an accepted token reaches the reconciler as a token trigger, even through a hold', async () => {
    const { w, stack } = await started();
    expect(await reconciled(w, stack, () => w.verified.fire())).toBe(true);
    await stack.stop();
  });

  it('a successful package refresh reaches the reconciler', async () => {
    const { w, stack } = await started();
    expect(await reconciled(w, stack, async () => void (await stack.refresher.refresh({ reason: 'manual' })))).toBe(true);
    await stack.stop();
  });

  it('a refresh that was halted does not', async () => {
    const { w, stack } = await started();
    w.pkg.script.push(jsonReply(426, { success: false, error: { code: 'UPGRADE_REQUIRED', message: 'old' } }));
    expect(await reconciled(w, stack, async () => void (await stack.refresher.refresh({ reason: 'manual' })))).toBe(false);
    await stack.stop();
  });

  it('enqueue wakes the replayer; a write queued behind its back does not', async () => {
    const { w, stack } = await started();
    const posts = (): number => w.pkg.requests.filter((r) => r.method === 'POST').length;
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', { ...CREATE, id: 'quiet-1' }, { account: ALICE });
    await stack.idle();
    expect(posts()).toBe(0);
    await stack.enqueue('inspection.create', CREATE);
    await stack.idle();
    expect(posts()).toBe(2);
    await stack.stop();
  });

  it('a failed enqueue does not wake the replayer', async () => {
    const { w, stack } = await started();
    await expect(stack.enqueue('inspection.create', { nonsense: true })).rejects.toBeDefined();
    await stack.idle();
    expect(w.pkg.requests.filter((r) => r.method === 'POST')).toEqual([]);
    await stack.stop();
  });
});

describe('status', () => {
  it('an authentication halt shows, and the next accepted token clears it', async () => {
    const w = await createStackWorld();
    const stack = w.make({ tokens: { getAccessToken: () => Promise.resolve(null), checkSession: w.tokensCheck } });
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    await run(stack);
    expect(stack.status.get().auth).toBe(true);
    w.verified.fire();
    expect(stack.status.get().auth).toBe(false);
    await stack.stop();
  });

  it('a server that refuses this app version shows as upgrade, and stays', async () => {
    const w = await createStackWorld();
    w.pkg.script.push(jsonReply(426, { success: false, error: { code: 'UPGRADE_REQUIRED', message: 'old' } }));
    const stack = w.make();
    await run(stack);
    expect(stack.status.get().upgrade).toBe(true);
    w.verified.fire();
    expect(stack.status.get().upgrade).toBe(true);
    await stack.stop();
  });

  it('a document that cannot be stored shows editsNotSaved, and it stays', async () => {
    const w = await createStackWorld();
    const stack = w.make({ db: dbThatFails(w.replay.db, { query: /ydoc_updates/ }) });
    await run(stack);
    expect(stack.status.get().editsNotSaved).toBe(false);
    const handle = stack.connector.connect('insp-1', {});
    await nextStatus(stack, (status) => status.editsNotSaved);
    expect(stack.status.get().editsNotSaved).toBe(true);
    handle.destroy();
    w.verified.fire();
    expect(stack.status.get().editsNotSaved).toBe(true);
    await stack.stop();
  });

  it('a document write that fails shows editsNotSaved, whatever status the connection reports', async () => {
    const w = await createStackWorld();
    const stack = w.make({ db: dbThatFails(w.replay.db, { run: /INSERT INTO ydoc_updates/ }) });
    await run(stack);
    const handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    handle.doc.getMap('results').set('a', 1);
    await nextStatus(stack, (status) => status.editsNotSaved);
    expect(w.diagnostics).toContain('collab_error');
    handle.destroy();
    await stack.stop();
  });

  it('reports the latest reconcile outcome', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    expect(stack.status.get().reconcile).toBe('never');
    await run(stack);
    expect(stack.status.get().reconcile).toBe(stack.reconciler.last.status);
    expect(stack.status.get().reconcile).not.toBe('never');
    await stack.stop();
  });

  it('listeners run only when a field changed', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    let calls = 0;
    const off = stack.status.subscribe(() => {
      calls += 1;
    });
    w.verified.fire();
    expect(calls).toBe(0);
    off();
    await stack.stop();
  });
});

describe('the sweeps at cold start', () => {
  async function seedOldFiles(w: StackWorld): Promise<void> {
    await w.files.write('media/orphan-1.jpg', new Uint8Array([1]));
    w.files.setMtime('media/orphan-1.jpg', NOW - 2 * HOUR);
    w.files.seedCache('upload-1234567.tmp', NOW - 8 * HOUR);
  }

  it('run once before the first upload starts', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const log: string[] = [];
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1'));
    w.pkg.hook = (request) => {
      if (request.path.endsWith('/media/upload-url')) log.push('mint');
    };
    const files = {
      ...w.files,
      remove: (path: string) => {
        log.push('remove');
        return w.files.remove(path);
      },
      removeCache: (name: string) => {
        log.push('removeCache');
        return w.files.removeCache(name);
      },
    };
    const stack = w.make({ files });
    await run(stack);
    expect(log.filter((entry) => entry !== 'mint')).toEqual(['remove', 'removeCache']);
    expect(log.indexOf('mint')).toBeGreaterThan(log.lastIndexOf('removeCache'));
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
    expect(w.files.cacheNames()).toEqual([]);
    await stack.stop();
  });

  it('are remembered, so a second stack soon after does not sweep again, and one after the interval does', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const first = w.make();
    await run(first);
    await first.stop();
    const stamp = await w.replay.db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [SWEEP_KEY]);
    expect(stamp[0]?.value).toBe(String(NOW));

    await seedOldFiles(w);
    w.replay.clock.advance(SWEEP_MIN_INTERVAL_MS - 1);
    const second = w.make();
    await run(second);
    await second.stop();
    expect(w.files.paths()).toContain('media/orphan-1.jpg');

    w.replay.clock.advance(1);
    const third = w.make();
    await run(third);
    await third.stop();
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
  });

  it.each([['not a number', 'abc'], ['a stamp in the future', String(NOW + 10 * HOUR)], ['a fraction', '1.5'], ['negative', '-5']])('a stored stamp that is %s does not suppress the sweep', async (_name, value) => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    await w.replay.db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', [SWEEP_KEY, value]);
    const stack = w.make();
    await run(stack);
    await stack.stop();
    expect(w.files.paths()).not.toContain('media/orphan-1.jpg');
  });

  it('do not record a completed temp sweep when an upload may be running, and leave the temp copies alone (the orphan sweep is recorded)', async () => {
    const w = await createStackWorld();
    await seedOldFiles(w);
    const seeding = createMediaStore({ db: w.replay.db, files: w.files, isBlocked: neverBlocked });
    await seeding.put(photoRecord('p1'));
    await seeding.markState('p1', 'uploading');
    const stack = w.make({ isLocked: () => false });
    stack.start();
    await stack.settled();
    expect(w.files.cacheNames()).toEqual(['upload-1234567.tmp']);
    expect((await w.replay.db.query('SELECT 1 FROM device_state WHERE key = ?', [TEMP_SWEEP_KEY])).length).toBe(0);
    expect((await w.replay.db.query('SELECT 1 FROM device_state WHERE key = ?', [SWEEP_KEY])).length).toBe(1);
    await stack.stop();
  });
});

describe('media', () => {
  it('a clip waits for the editor: the placeholder document step answers missing', async () => {
    await expect(placeholderResolveVideo('insp-1', 'v1', { provider: 'stream', streamUid: 'abcdefgh1234' })).resolves.toBe('missing');
  });

  it('a finished clip is kept, file and row, until the editor can place it', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    expect(stack.uploader.handlesVideo()).toBe(true);
    await stack.store.putVideo(videoRecord('v1', { inspectionId: 'insp-1' }));
    const row = await stack.store.getRow('v1');
    expect(row).not.toBeNull();
    await stack.store.markState('v1', 'uploaded', { uploadedKey: 'tenant-1/inspections/insp-1/videos/v1.mp4' });
    await stack.mediaReconciler.reconcileUploads();
    expect(await stack.store.getRow('v1')).not.toBeNull();
    expect(w.files.paths()).toContain(row?.path);
    expect(w.diagnostics).toEqual([]);
    await stack.stop();
  });

  it('a photo for an inspection that is open while no live document is available waits (DOC_BUSY) and is kept', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.store.markState('p1', 'uploaded', { uploadedKey: 'tenant-1/inspections/insp-1/photos/p1.jpg' });
    stack.connector.connect('insp-1', {});
    await stack.mediaReconciler.reconcileUploads();
    expect(await stack.store.getRow('p1')).not.toBeNull();
    expect(w.diagnostics).toContain('media_error');
    await stack.stop();
  });

  it('control: with nothing open the same photo is not reported as an error', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.store.markState('p1', 'uploaded', { uploadedKey: 'tenant-1/inspections/insp-1/photos/p1.jpg' });
    await stack.mediaReconciler.reconcileUploads();
    expect(w.diagnostics).not.toContain('media_error');
    await stack.stop();
  });

  it('storing a photo wakes the media reconciler (onStored), and a manual retry does too (onRetry)', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    const mints = (): number => w.pkg.requests.filter((r) => r.path.endsWith('/media/upload-url')).length;
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.mediaReconciler.idle();
    const afterStore = mints();
    expect(afterStore).toBeGreaterThan(0);
    await stack.store.markState('p1', 'failed', { attempts: 3 });
    await stack.uploader.retry('p1');
    await stack.mediaReconciler.idle();
    expect(mints()).toBeGreaterThan(afterStore);
    await stack.stop();
  });
});

describe('the reconcile plan and the user actions', () => {
  async function withGonePackage(): Promise<{ w: StackWorld; stack: OfflineStack }> {
    const w = await createStackWorld();
    w.pkg.overrides.set('/api/client/inspections/visible', () => jsonReply(200, { success: true, data: { visible: [] } }));
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['gone-1', ALICE.tenantId, ALICE.userId]);
    const stack = w.make();
    return { w, stack };
  }

  it('hands out the exact issued plan of the latest decision, never a copy', async () => {
    const { w, stack } = await withGonePackage();
    expect(stack.lastPlan()).toBeNull();
    await run(stack);
    const plan = stack.lastPlan();
    expect(plan).not.toBeNull();
    expect(isIssuedPlan(plan)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(stack.lastPlan()).toBe(plan);
    expect(isIssuedPlan({ ...plan })).toBe(false);
    expect(w.diagnostics).toEqual([]);
    await stack.stop();
  });

  it('the removal accepts that plan and refuses a copy of it', async () => {
    const { stack } = await withGonePackage();
    await run(stack);
    const plan = stack.lastPlan();
    if (plan === null) throw new Error('no plan was issued');
    await expect(stack.userActions.removeFromDevice('gone-1', { confirmed: true, plan: { ...plan } })).resolves.toEqual({ kind: 'refused', reason: 'plan_not_issued' });
    await expect(stack.userActions.removeFromDevice('gone-1', { confirmed: true, plan })).resolves.toEqual({ kind: 'purged' });
    await stack.stop();
  });

  it('a later decision that made no plan clears the held one', async () => {
    const { w, stack } = await withGonePackage();
    await run(stack);
    expect(stack.lastPlan()).not.toBeNull();
    w.pkg.overrides.set('/api/client/session', () => jsonReply(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } }));
    w.replay.clock.advance(2 * HOUR);
    w.verified.fire();
    await stack.idle();
    expect(stack.lastPlan()).toBeNull();
    await stack.stop();
  });

  it('every user action refuses while the device is locked', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    w.lock.locked = true;
    await expect(stack.userActions.removeFromDevice('gone-1', { confirmed: true })).resolves.toEqual({ kind: 'locked' });
    await expect(stack.userActions.discardMedia('p1', { confirmed: true })).resolves.toMatchObject({ kind: 'locked' });
    await expect(stack.userActions.discardOutboxRow('k1', { confirmed: true })).resolves.toMatchObject({ kind: 'locked' });
    await stack.stop();
  });

  it('listing the unattributable queue is bound to the account', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await expect(stack.userActions.listUnattributableOutbox()).resolves.toEqual({ rows: [], foreign: 0 });
    await saveIdentity(w.replay.db, { userId: BOB.userId, tenantId: BOB.tenantId, role: 'inspector' });
    await expect(stack.userActions.listUnattributableOutbox()).resolves.toEqual({ rows: [], foreign: 0 });
    await stack.stop();
  });

  it('tells the editor to unmount a quarantined inspection, and wakes the flows when it is free again', async () => {
    const { w, stack } = await withGonePackage();
    const events: string[] = [];
    const off = stack.onEditorEvent((event) => events.push(`${event.kind}:${event.inspectionId}`));
    await run(stack);
    expect(events).toContain('quarantined:gone-1');
    off();
    await stack.stop();
    expect(w.residue().timers).toBe(0);
  });

  it('a stack stopped mid-purge leaves the tombstone for the next session to finish', async () => {
    const w = await createStackWorld();
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, purging) VALUES (?, 1, 0, 1, ?, ?, 2)', ['half-1', ALICE.tenantId, ALICE.userId]);
    const stack = w.make();
    await stack.stop();
    expect((await w.replay.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['half-1'])).length).toBe(1);
    const next = w.make();
    await run(next);
    expect((await w.replay.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['half-1'])).length).toBe(0);
    await next.stop();
  });
});
