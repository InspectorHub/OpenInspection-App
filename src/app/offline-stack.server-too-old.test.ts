import { describe, expect, it, vi } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import type { SocketFactory } from '../collab/connector';
import { photoRecord } from '../media/test-support/fakes';
import { enqueue } from '../offline/outbox';
import { ALICE, ORIGIN } from '../offline/test-support/replay-world';
import { jsonReply } from '../offline/test-support/package-world';
import { createMemoryKeyValue } from '../platform/kv';
import { createClientState, serverTooOldFor, type ClientStateController } from './client-state';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

function compat(tooOld: boolean): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: tooOld ? 0 : 2, serverTooOld: tooOld, nativeLoginVerified: false };
}

function clientState(tooOld: boolean | null): ClientStateController {
  const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
  if (tooOld !== null) state.applyCompat(ORIGIN, compat(tooOld));
  return state;
}

/** A device with one queued write and one held package waiting, and the server route a photo upload needs. */
async function loaded(w: StackWorld): Promise<void> {
  // A package the device already holds: the reconciler has something to ask the server about.
  await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['held-1', ALICE.tenantId, ALICE.userId]);
  await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
  w.pkg.overrides.set('/api/inspections/insp-1/media/upload-url', () =>
    jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'tenant-1/inspections/insp-1/photos/p1.jpg', expiresAt: 9_999_999_999_999 } }),
  );
}

/** Lets every already-resolved promise run. Microtasks only: no timer, no clock. */
async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

const paths = (w: StackWorld): string[] => w.pkg.requests.map((r) => `${r.method} ${r.path}`);

/** Everything that talks to the server, poked once each: the replayer, the refresher, the reconciler, the uploader, the connector. */
async function pokeEverySyncFlow(stack: OfflineStack): Promise<void> {
  await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
  await stack.mediaReconciler.idle();
  await stack.uploader.uploadDetailed({ pendingId: 'p1', inspectionId: 'insp-1' });
  await stack.replayer.replay();
  await stack.refresher.refresh({ reason: 'manual' });
  stack.reconciler.trigger('manual');
  await stack.idle();
  const handle = stack.connector.connect('insp-1', {});
  await handle.persistenceSynced;
  await flush();
  await stack.idle();
  handle.destroy();
}

describe('a server on an older contract: no sync, local work goes on (Review Focus 5)', () => {
  it('control: with a sufficient contract every sync flow talks to the server', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const stack = w.make({ serverTooOld: serverTooOldFor(clientState(false), ORIGIN) });
    await run(stack);
    await pokeEverySyncFlow(stack);
    const seen = paths(w);
    expect(seen).toContain('POST /api/inspections');
    expect(seen).toContain('GET /api/inspections');
    expect(seen).toContain('POST /api/client/inspections/visible');
    expect(seen.some((p) => p.endsWith('/media/upload-url'))).toBe(true);
    expect(seen.some((p) => p.includes('/collab/'))).toBe(true);
    await stack.stop();
  });

  it('too old: the replayer, refresher, reconciler, uploader and connector make zero requests, open no socket and start no upload', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const stack = w.make({ serverTooOld: serverTooOldFor(clientState(true), ORIGIN) });
    await run(stack);
    await pokeEverySyncFlow(stack);
    expect(w.pkg.requests).toEqual([]);
    expect(w.sockets.opened).toEqual([]);
    expect(w.plugin.starts).toEqual([]);
    await stack.stop();
  });

  it('too old: local reads and writes still work, and nothing is reported as a failure', async () => {
    const w = await createStackWorld();
    const stack = w.make({ serverTooOld: serverTooOldFor(clientState(true), ORIGIN) });
    await run(stack);
    const row = await stack.enqueue('inspection.create', CREATE);
    expect(row.state).toBe('pending');
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    expect((await stack.store.getRow('p1'))?.state).toBe('pending');
    const handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    handle.doc.getMap('results').set('a', 1);
    await stack.idle();
    const stored = await w.replay.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates');
    expect(stored[0]?.n).toBeGreaterThan(0);
    expect(stack.status.get()).toMatchObject({ editsNotSaved: false, collabIssue: false, auth: false, upgrade: false });
    expect(w.diagnostics).toEqual([]);
    expect(w.pkg.requests).toEqual([]);
    handle.destroy();
    await stack.stop();
  });

  it('too old: a user action that only touches the device still works', async () => {
    const w = await createStackWorld();
    const stack = w.make({ serverTooOld: serverTooOldFor(clientState(true), ORIGIN) });
    await run(stack);
    await stack.store.put(photoRecord('p1', { inspectionId: 'orphan-1' }));
    await expect(stack.userActions.discardMedia('p1', { confirmed: true })).resolves.toMatchObject({ kind: 'discarded' });
    expect(await stack.store.getRow('p1')).toBeNull();
    expect(w.pkg.requests).toEqual([]);
    await stack.stop();
  });

  it('unknown is not too old: a server that never answered the compat request is synced with', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const stack = w.make({ serverTooOld: serverTooOldFor(clientState(null), ORIGIN) });
    await run(stack);
    expect(paths(w)).toContain('POST /api/inspections');
    await stack.stop();
  });

  it('learning that the server is too old closes a connection that is already open', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set('/api/inspections/insp-1/collab/ticket', () => jsonReply(200, { success: true, data: { ticket: 'ticket0123456789abcdef' } }));
    const closed: string[] = [];
    const state = clientState(false);
    const openSocket: SocketFactory = (url, handlers) => {
      queueMicrotask(() => handlers.open());
      return { isOpen: () => true, send: () => undefined, close: () => void closed.push(url) };
    };
    const stack = w.make({ serverTooOld: serverTooOldFor(state, ORIGIN), openSocket });
    await run(stack);
    const handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await flush();
    expect(closed).toEqual([]);
    const tickets = w.pkg.requests.filter((r) => r.path.includes('/collab/ticket')).length;
    expect(tickets).toBeGreaterThan(0);
    state.applyCompat(ORIGIN, compat(true));
    await flush();
    expect(closed.length).toBeGreaterThan(0);
    expect(w.pkg.requests.filter((r) => r.path.includes('/collab/ticket')).length).toBe(tickets);
    handle.destroy();
    await stack.stop();
  });

  it('the server being updated resumes sync by itself, with no unlock and no restart', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const state = clientState(true);
    const stack = w.make({ serverTooOld: serverTooOldFor(state, ORIGIN) });
    await run(stack);
    expect(w.pkg.requests).toEqual([]);
    state.applyCompat(ORIGIN, compat(false));
    await stack.idle();
    expect(paths(w)).toContain('POST /api/inspections');
    await stack.stop();
  });

  it('learning that the server is too old after the stack is running stops the next requests', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const state = clientState(false);
    const stack = w.make({ serverTooOld: serverTooOldFor(state, ORIGIN) });
    await run(stack);
    const before = w.pkg.requests.length;
    expect(before).toBeGreaterThan(0);
    state.applyCompat(ORIGIN, compat(true));
    await stack.enqueue('inspection.update', { inspectionId: 'insp-1', changes: { sqft: 10 } });
    await stack.store.put(photoRecord('p2', { inspectionId: 'insp-1' }));
    await stack.refresher.refresh({ reason: 'manual' });
    await stack.idle();
    expect(w.pkg.requests.length).toBe(before);
    await stack.stop();
  });

  it('a stack that has stopped leaves no listener on the contract state, and a later change starts nothing', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const state = clientState(true);
    const stack = w.make({ serverTooOld: serverTooOldFor(state, ORIGIN) });
    await run(stack);
    await stack.stop();
    expect(w.residue().unlock).toBe(0);
    state.applyCompat(ORIGIN, compat(false));
    expect(w.residue().unlock).toBe(0);
    expect(w.pkg.requests).toEqual([]);
  });
});

describe('beforeLaunch: the contract is looked at once before the first flow, only while online', () => {
  it('runs before the first request, and what it learns gates that very first replay', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const state = clientState(null);
    const beforeLaunch = vi.fn(() => {
      expect(w.pkg.requests).toEqual([]);
      state.applyCompat(ORIGIN, compat(true));
      return Promise.resolve();
    });
    const stack = w.make({ serverTooOld: serverTooOldFor(state, ORIGIN), beforeLaunch });
    await run(stack);
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    expect(w.pkg.requests).toEqual([]);
    await stack.stop();
  });

  it('control: when it learns the server is fine the first replay goes ahead', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const state = clientState(null);
    const stack = w.make({
      serverTooOld: serverTooOldFor(state, ORIGIN),
      beforeLaunch: () => {
        state.applyCompat(ORIGIN, compat(false));
        return Promise.resolve();
      },
    });
    await run(stack);
    expect(paths(w)).toContain('POST /api/inspections');
    await stack.stop();
  });

  it('is not asked while the device is offline: no request is made to find out', async () => {
    const w = await createStackWorld();
    w.replay.network.setQuietly(false);
    const beforeLaunch = vi.fn(() => Promise.resolve());
    const stack = w.make({ beforeLaunch });
    await run(stack);
    expect(beforeLaunch).not.toHaveBeenCalled();
    await stack.stop();
  });

  it('a rejection is ignored and the launch goes on', async () => {
    const w = await createStackWorld();
    await loaded(w);
    const stack = w.make({ beforeLaunch: () => Promise.reject(new Error('compat blew up')) });
    await run(stack);
    expect(paths(w)).toContain('POST /api/inspections');
    await stack.stop();
  });
});
