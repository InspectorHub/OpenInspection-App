import { describe, expect, it, vi } from 'vitest';
import type { CollabConnectorDeps } from '../collab/connector';
import { CollabIssue } from '../collab/connector';
import type { NativeUploaderDeps } from '../media/native-uploader';
import type { createMediaReconciler } from '../media/reconcile';
import type { ReconcilerDeps } from '../offline/reconciler';
import type { ReplayDeps } from '../offline/replay';
import type { createWorkPackageRefresher } from '../offline/work-package';
import { jsonReply } from '../offline/test-support/package-world';
import { ALICE } from '../offline/test-support/replay-world';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

/** What each factory the stack calls was handed, and what it returned, by name (the latest call of each). */
const seen = vi.hoisted(() => ({
  deps: new Map<string, unknown>(),
  made: new Map<string, unknown>(),
  calls: [] as string[],
}));

function recording<D, R extends object>(name: string, real: (deps: D) => R): (deps: D) => R {
  return (deps) => {
    seen.deps.set(name, deps);
    const made = real(deps);
    seen.made.set(name, made);
    return made;
  };
}

vi.mock('../collab/connector', async (importOriginal) => {
  const real = await importOriginal<typeof import('../collab/connector')>();
  return {
    ...real,
    createCollabConnector: (deps: CollabConnectorDeps) => {
      seen.deps.set('connector', deps);
      const connector = real.createCollabConnector(deps);
      const wrapped: typeof connector = {
        ...connector,
        connect: (inspectionId, opts) => {
          const handle = connector.connect(inspectionId, opts);
          let n = 0;
          const label = `destroy:${inspectionId}`;
          return new Proxy(handle, {
            get: (target, key) => {
              if (key === 'destroy') {
                return () => {
                  n += 1;
                  seen.calls.push(`${label}#${String(n)}`);
                  target.destroy();
                };
              }
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          });
        },
      };
      seen.made.set('connector', wrapped);
      return wrapped;
    },
  };
});
vi.mock('../media/native-uploader', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/native-uploader')>();
  return {
    ...real,
    createNativeUploader: (deps: NativeUploaderDeps) => {
      seen.deps.set('uploader', deps);
      const uploader = real.createNativeUploader(deps);
      const wrapped: typeof uploader = {
        ...uploader,
        dispose: () => {
          seen.calls.push('uploader.dispose');
          return uploader.dispose();
        },
      };
      seen.made.set('uploader', wrapped);
      return wrapped;
    },
  };
});
vi.mock('../media/reconcile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../media/reconcile')>();
  return {
    ...real,
    createMediaReconciler: (deps: Parameters<typeof createMediaReconciler>[0]) => {
      seen.deps.set('mediaReconciler', deps);
      const made = real.createMediaReconciler(deps);
      const wrapped: typeof made = {
        ...made,
        trigger: () => {
          seen.calls.push('media.trigger');
          made.trigger();
        },
      };
      seen.made.set('mediaReconciler', wrapped);
      return wrapped;
    },
  };
});
vi.mock('../offline/replay', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/replay')>();
  return {
    ...real,
    createReplayer: (deps: ReplayDeps) => {
      seen.deps.set('replayer', deps);
      const made = real.createReplayer(deps);
      const wrapped: typeof made = {
        ...made,
        trigger: () => {
          seen.calls.push('replay.trigger');
          made.trigger();
        },
      };
      seen.made.set('replayer', wrapped);
      return wrapped;
    },
  };
});
vi.mock('../offline/work-package', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/work-package')>();
  return { ...real, createWorkPackageRefresher: recording<Parameters<typeof createWorkPackageRefresher>[0], ReturnType<typeof real.createWorkPackageRefresher>>('refresher', real.createWorkPackageRefresher) };
});
vi.mock('../offline/reconciler', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/reconciler')>();
  return { ...real, createReconciler: recording<ReconcilerDeps, ReturnType<typeof real.createReconciler>>('reconciler', real.createReconciler) };
});
vi.mock('../offline/reconcile-execute', async (importOriginal) => {
  const real = await importOriginal<typeof import('../offline/reconcile-execute')>();
  return {
    ...real,
    executeReconcilePlan: (deps: Parameters<typeof real.executeReconcilePlan>[0], plan: Parameters<typeof real.executeReconcilePlan>[1]) => {
      seen.deps.set('execute', deps);
      return real.executeReconcilePlan(deps, plan);
    },
  };
});

function depsOf<T>(name: string): T {
  const found = seen.deps.get(name);
  if (found === undefined) throw new Error(`no ${name} was built`);
  return found as T;
}

const FLOWS = ['replayer', 'refresher', 'reconciler', 'mediaReconciler', 'connector', 'uploader'] as const;
type Flow = (typeof FLOWS)[number];

async function build(overrides: Parameters<StackWorld['make']>[0] = {}): Promise<{ w: StackWorld; stack: ReturnType<StackWorld['make']> }> {
  seen.deps.clear();
  seen.made.clear();
  seen.calls.length = 0;
  const w = await createStackWorld();
  return { w, stack: w.make(overrides) };
}

describe('one clock, one lock check, one unlock source', () => {
  it('every flow gets the SAME clock instance that the stack was given', async () => {
    const { w, stack } = await build();
    for (const flow of FLOWS) expect(depsOf<{ clock: unknown }>(flow).clock).toBe(w.replay.clock);
    await stack.stop();
  });

  it.each(['replayer', 'refresher', 'reconciler', 'mediaReconciler'] as const)('the unlock subscription of the %s reaches the unlock source of the stack, and unsubscribes', async (flow) => {
    const { w, stack } = await build();
    const subscribe = depsOf<{ onUnlocked?: (listener: () => void) => () => void }>(flow).onUnlocked;
    expect(subscribe).toBeTypeOf('function');
    let heard = 0;
    const off = subscribe?.(() => {
      heard += 1;
    });
    expect(w.residue().unlock).toBe(1);
    w.unlocks.note({ locked: true, reason: 'expired' });
    w.unlocks.note({ locked: false });
    expect(heard).toBe(1);
    off?.();
    expect(w.residue().unlock).toBe(0);
    w.unlocks.note({ locked: true, reason: 'expired' });
    w.unlocks.note({ locked: false });
    expect(heard).toBe(1);
    await stack.stop();
  });

  it.each(FLOWS)('the lock check of the %s is the one of the stack: locked while the device is locked, and for good once the stack has stopped', async (flow: Flow) => {
    const { w, stack } = await build();
    const isLocked = depsOf<{ isLocked(): boolean | Promise<boolean> }>(flow).isLocked;
    expect(await isLocked()).toBe(false);
    w.lock.locked = true;
    expect(await isLocked()).toBe(true);
    w.lock.locked = false;
    expect(await isLocked()).toBe(false);
    await stack.stop();
    expect(await isLocked()).toBe(true);
  });
});

describe('the status fields', () => {
  it('a storage_failed status of a connection sets editsNotSaved by itself; the other statuses do not', async () => {
    const heard: string[] = [];
    const { stack } = await build({ onCollabStatus: (_id, status) => heard.push(status) });
    const onStatus = depsOf<CollabConnectorDeps>('connector').onStatus;
    onStatus?.('insp-1', 'offline');
    expect(stack.status.get().editsNotSaved).toBe(false);
    onStatus?.('insp-1', 'storage_failed');
    expect(stack.status.get().editsNotSaved).toBe(true);
    expect(heard).toEqual(['offline', 'storage_failed']);
    await stack.stop();
  });

  it('a collaboration issue is not sticky: the next synced status clears it; a persistence error is sticky', async () => {
    const { stack } = await build();
    const deps = depsOf<CollabConnectorDeps>('connector');
    deps.onError?.(new CollabIssue('The collaboration socket could not be opened'));
    expect(stack.status.get()).toMatchObject({ collabIssue: true, editsNotSaved: false });
    deps.onStatus?.('insp-1', 'synced');
    expect(stack.status.get().collabIssue).toBe(false);
    deps.onError?.(new Error('a document write failed'));
    expect(stack.status.get()).toMatchObject({ editsNotSaved: true, collabIssue: false });
    deps.onStatus?.('insp-1', 'synced');
    expect(stack.status.get().editsNotSaved).toBe(true);
    await stack.stop();
  });

  it.each([
    ['signed_out', { auth: true, upgrade: false }],
    ['auth_rejected', { auth: true, upgrade: false }],
    ['upgrade_required', { auth: false, upgrade: true }],
    ['offline', { auth: false, upgrade: false }],
    ['denied', { auth: false, upgrade: false }],
  ] as const)('a connection reporting %s sets %j', async (status, expected) => {
    const { stack } = await build();
    depsOf<CollabConnectorDeps>('connector').onStatus?.('insp-1', status);
    expect(stack.status.get()).toMatchObject(expected);
    await stack.stop();
  });

  it.each([
    ['replayer', 'auth', { auth: true, upgrade: false }],
    ['replayer', 'upgrade', { auth: false, upgrade: true }],
    ['replayer', 'locked', { auth: false, upgrade: false }],
    ['refresher', 'auth', { auth: true, upgrade: false }],
    ['refresher', 'upgrade', { auth: false, upgrade: true }],
  ] as const)('the %s halting for %s sets %j', async (flow, reason, expected) => {
    const { stack } = await build();
    depsOf<{ onHalt?: (reason: string) => void }>(flow).onHalt?.(reason);
    expect(stack.status.get()).toMatchObject(expected);
    await stack.stop();
  });
});

describe('an inspection that is free again', () => {
  it('wakes the media reconciler and the replayer, and tells the editor', async () => {
    const { w, stack } = await build();
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', ['gone-1', ALICE.tenantId, ALICE.userId]);
    w.pkg.overrides.set('/api/client/inspections/visible', () => jsonReply(200, { success: true, data: { visible: [] } }));
    stack.start();
    await stack.settled();
    await stack.idle();
    const executeDeps = depsOf<{ onUnquarantined(inspectionId: string): void }>('execute');
    const events: string[] = [];
    stack.onEditorEvent((event) => events.push(`${event.kind}:${event.inspectionId}`));
    seen.calls.length = 0;
    executeDeps.onUnquarantined('gone-1');
    expect(events).toEqual(['unquarantined:gone-1']);
    expect(seen.calls).toEqual(['media.trigger', 'replay.trigger']);
    await stack.stop();
  });
});

describe('stop()', () => {
  it('ends the uploader once, however often it is called', async () => {
    const { stack } = await build();
    await Promise.all([stack.stop(), stack.stop()]);
    await stack.stop();
    expect(seen.calls.filter((call) => call === 'uploader.dispose')).toEqual(['uploader.dispose']);
  });

  it('destroys only the connections that are still open: a handle the caller already destroyed is not tracked any more', async () => {
    const { stack } = await build();
    const first = stack.connector.connect('insp-1', {});
    const second = stack.connector.connect('insp-2', {});
    stack.connector.connect('insp-3', {});
    first.destroy();
    second.destroy();
    await stack.stop();
    expect(seen.calls.filter((call) => call.startsWith('destroy:'))).toEqual(['destroy:insp-1#1', 'destroy:insp-2#1', 'destroy:insp-3#1']);
  });
});

describe('a refused write asks for a reconcile', () => {
  it('is ignored until the stack has started its reconciler (the first flow covers it), and reaches it afterwards', async () => {
    const { w, stack } = await build();
    const ask = depsOf<{ onNeedsReconcile(inspectionId: string): void }>('replayer').onNeedsReconcile;
    ask('insp-1');
    await stack.idle();
    expect(stack.reconciler.last.status).toBe('never');

    stack.start();
    await stack.settled();
    await stack.idle();
    w.replay.clock.advance(2 * 3_600_000);
    const before = stack.reconciler.last.at;
    ask('insp-1');
    await stack.idle();
    expect(stack.reconciler.last.at).not.toBe(before);
    await stack.stop();
  });
});
