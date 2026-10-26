import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '../auth/http';
import { photoRecord } from '../media/test-support/fakes';
import { enqueue } from '../offline/outbox';
import { ALICE, ORIGIN } from '../offline/test-support/replay-world';
import { jsonReply } from '../offline/test-support/package-world';
import { createMemoryKeyValue } from '../platform/kv';
import { clientPolicy, createClientState, factsFor, type ClientStateController } from './client-state';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

const CREATE = (id: string) => ({ id, propertyAddress: '12 Test Street', templateId: 'template-1' });

/** The routes the engine never answers 426 for (its `NEVER_BLOCK_RULES`): the hand-over of captured work. */
function neverBlocked(req: HttpRequest): boolean {
  const path = new URL(req.url).pathname;
  return (
    (req.method === 'POST' && path === '/api/inspections') ||
    path.endsWith('/media/upload-url') ||
    path.includes('/collab/ticket') ||
    path === '/api/client/session'
  );
}

/**
 * An engine whose minimum version is above this app: it answers the routes above normally and every other call with 426, and
 * marks every response `X-Client-Upgrade: required`. Each answer is reported to the client state the way the real http layer does.
 */
function engineAboveThisApp(w: StackWorld, state: ClientStateController, attempted: string[] = []): Http {
  return {
    request: async (req): Promise<HttpResponse> => {
      attempted.push(`${req.method} ${new URL(req.url).pathname}`);
      const answer = neverBlocked(req) ? await w.pkg.http.request(req) : jsonReply(426, { success: false, error: { code: 'CLIENT_UPGRADE_REQUIRED' } });
      state.noteUpgrade(ORIGIN, 'required');
      return { ...answer, upgrade: 'required' };
    },
  };
}

async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const sent = (w: StackWorld): string[] => w.pkg.requests.map((r) => `${r.method} ${r.path}`);

describe('upgrade required: editing stops, the hand-over of captured work does not (Review Focus 4)', () => {
  it('the policy says no editing, but sync and export stay on', () => {
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    expect(clientPolicy(state.store.get(), ORIGIN).canEdit).toBe(true);
    state.noteUpgrade(ORIGIN, 'required');
    expect(clientPolicy(state.store.get(), ORIGIN)).toEqual({ canEdit: false, canSync: true, canExport: true });
  });

  it('the replayer keeps sending queued writes, also writes queued after a 426 was seen', async () => {
    const w = await createStackWorld();
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE('insp-1'), { account: ALICE });
    const attempted: string[] = [];
    const stack = w.make({ http: engineAboveThisApp(w, state, attempted) });
    await run(stack);
    expect(factsFor(state.store.get(), ORIGIN).upgrade).toBe('required');
    expect(sent(w).filter((p) => p === 'POST /api/inspections')).toHaveLength(1);
    // The refresher's read was refused with 426 (it never reached the fake engine), so the refusal really happened on this run.
    expect(attempted).toContain('GET /api/inspections');
    expect(sent(w)).not.toContain('GET /api/inspections');
    expect(stack.status.get().upgrade).toBe(true);
    await stack.enqueue('inspection.create', CREATE('insp-2'));
    await stack.replayer.idle();
    expect(sent(w).filter((p) => p === 'POST /api/inspections')).toHaveLength(2);
    const left = await w.replay.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending', 'failed')");
    expect(left[0]?.n).toBe(0);
    await stack.stop();
  });

  it('the uploader and the media reconciler keep uploading a captured photo', async () => {
    const w = await createStackWorld();
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    w.pkg.overrides.set('/api/inspections/insp-1/media/upload-url', () =>
      jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: 'tenant-1/inspections/insp-1/photos/p1.jpg', expiresAt: 9_999_999_999_999 } }),
    );
    const stack = w.make({ http: engineAboveThisApp(w, state) });
    await run(stack);
    state.noteUpgrade(ORIGIN, 'required');
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.mediaReconciler.idle();
    expect(sent(w).some((p) => p.endsWith('/media/upload-url'))).toBe(true);
    expect(w.plugin.starts.length).toBeGreaterThan(0);
    expect(stack.status.get().upgrade).toBe(true);
    await stack.stop();
  });

  it('the collaboration connector still asks for a ticket and opens the socket', async () => {
    const w = await createStackWorld();
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    w.pkg.overrides.set('/api/inspections/insp-1/collab/ticket', () => jsonReply(200, { success: true, data: { ticket: 'ticket0123456789abcdef' } }));
    const stack = w.make({ http: engineAboveThisApp(w, state) });
    await run(stack);
    const handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    await flush();
    expect(sent(w).some((p) => p.includes('/collab/ticket'))).toBe(true);
    expect(w.sockets.opened.length).toBeGreaterThan(0);
    expect(factsFor(state.store.get(), ORIGIN).upgrade).toBe('required');
    handle.destroy();
    await stack.stop();
  });

  it('a 426 on the session check ends nothing: the account and the lock stay as they were', async () => {
    const w = await createStackWorld();
    const state = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    const stack = w.make({ http: engineAboveThisApp(w, state) });
    await run(stack);
    expect(stack.status.get().auth).toBe(false);
    expect(stack.isStopped()).toBe(false);
    const rows = await w.replay.db.query<{ key: string }>("SELECT key FROM device_state WHERE key IN ('user_id', 'tenant_id', 'role')");
    expect(rows).toHaveLength(3);
    await stack.stop();
  });
});
