import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { enqueue } from '../offline/outbox';
import { ALICE } from '../offline/test-support/replay-world';
import { jsonReply } from '../offline/test-support/package-world';
import { createStackWorld } from './test-support/stack-world';

/** Every `isBlocked` each factory or flow was handed, by name, and every guard `createBlockedGuard` made. */
const seen = vi.hoisted(() => ({ guards: [] as unknown[], handed: new Map<string, unknown>() }));

vi.mock('../offline/blocked', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/blocked')>();
  return {
    ...real,
    createBlockedGuard: (...args: Parameters<typeof real.createBlockedGuard>) => {
      const guard = real.createBlockedGuard(...args);
      seen.guards.push(guard);
      return guard;
    },
  };
});

function record<D extends { isBlocked: unknown }, A extends unknown[], R>(name: string, real: (deps: D, ...rest: A) => R): (deps: D, ...rest: A) => R {
  return (deps, ...rest) => {
    seen.handed.set(name, deps.isBlocked);
    return real(deps, ...rest);
  };
}

vi.mock('../collab/connector', async (importOriginal) => {
  const real = await importOriginal<typeof import('../collab/connector')>();
  return { ...real, createCollabConnector: record('connector', real.createCollabConnector) };
});
vi.mock('../media/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/store')>();
  return { ...real, createMediaStore: record('store', real.createMediaStore) };
});
vi.mock('../media/native-uploader', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/native-uploader')>();
  return { ...real, createNativeUploader: record('uploader', real.createNativeUploader) };
});
vi.mock('../media/reconcile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/reconcile')>();
  return { ...real, createMediaReconciler: record('mediaReconciler', real.createMediaReconciler) };
});
vi.mock('../media/pending-doc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/pending-doc')>();
  return { ...real, createWithDoc: record('withDoc', real.createWithDoc) };
});
vi.mock('../offline/replay', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/replay')>();
  return { ...real, createReplayer: record('replayer', real.createReplayer) };
});
vi.mock('../offline/purge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/purge')>();
  return { ...real, resumePurges: record('resumePurges', real.resumePurges) };
});
vi.mock('../offline/reconcile-execute', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/reconcile-execute')>();
  return { ...real, executeReconcilePlan: record('execute', real.executeReconcilePlan) };
});
vi.mock('../offline/user-actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/user-actions')>();
  return { ...real, removeFromDevice: record('removeFromDevice', real.removeFromDevice) };
});

const EXPECTED = ['connector', 'store', 'uploader', 'mediaReconciler', 'withDoc', 'replayer', 'resumePurges', 'execute', 'removeFromDevice'];

describe('one blocked guard for every module that requires one', () => {
  it('hands the SAME guard instance to every factory and every flow, and builds exactly one', async () => {
    const w = await createStackWorld();
    // A package the server no longer shows, so the reconcile flow quarantines it and the executor runs.
    w.pkg.overrides.set('/api/client/inspections/visible', () => jsonReply(200, { success: true, data: { visible: [] } }));
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['gone-1', ALICE.tenantId, ALICE.userId]);
    await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' }, { account: ALICE });
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    await stack.userActions.removeFromDevice('gone-1', { confirmed: true });
    await stack.stop();

    expect(seen.guards).toHaveLength(1);
    const guard = seen.guards[0];
    expect([...seen.handed.keys()].sort()).toEqual([...EXPECTED].sort());
    for (const name of EXPECTED) expect(seen.handed.get(name), name).toBe(guard);
    expect(typeof guard).toBe('function');
  });

  it('the source builds the guard once and never writes a stand-in', () => {
    const source = readFileSync(new URL('./offline-stack.ts', import.meta.url), 'utf8');
    expect(source.match(/createBlockedGuard\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/isBlocked\s*[:=]\s*(\(\)\s*=>|async|neverBlocked)/);
    expect(source).not.toMatch(/neverBlocked/);
  });
});
