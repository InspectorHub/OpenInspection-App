import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { createMemoryKeyValue } from '../platform/kv';
import { createClientState, factsFor } from './client-state';
import { contractPorts, LAUNCH_COMPAT_TIMEOUT_MS } from './real-stack';
import { createWorld } from './test-support/world';

const ORIGIN = 'https://oi.example.test';

describe('contractPorts', () => {
  it('reads the contract state of this server, and asks for a fresh look with a short ceiling', async () => {
    const clientState = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    const refreshCompat = vi.fn(() => Promise.resolve());
    const ports = contractPorts({ clientState, refreshCompat }, ORIGIN);
    expect(ports.serverTooOld?.get()).toBe(false);
    const compat: CompatInfo = { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 0, serverTooOld: true, nativeLoginVerified: false };
    clientState.applyCompat(ORIGIN, compat);
    expect(ports.serverTooOld?.get()).toBe(true);
    await ports.beforeLaunch?.();
    expect(refreshCompat).toHaveBeenCalledWith(ORIGIN, { timeoutMs: LAUNCH_COMPAT_TIMEOUT_MS });
    expect(LAUNCH_COMPAT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('a required update is not a reason to stop syncing: it never reads as a server that is too old', () => {
    const clientState = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    const ports = contractPorts({ clientState, refreshCompat: () => Promise.resolve() }, ORIGIN);
    clientState.noteUpgrade(ORIGIN, 'required');
    expect(factsFor(clientState.store.get(), ORIGIN).upgrade).toBe('required');
    expect(ports.serverTooOld?.get()).toBe(false);
  });
});

describe('contractPorts: the feature gates', () => {
  it('reads whether the compat answer is known and whether the check for removed inspections exists', () => {
    const clientState = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    const ports = contractPorts({ clientState, refreshCompat: () => Promise.resolve() }, ORIGIN);
    expect(ports.compatKnown?.()).toBe(false);
    expect(ports.reconcileSupported?.()).toBeNull();
    clientState.applyCompat(ORIGIN, { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false });
    expect(ports.compatKnown?.()).toBe(true);
    expect(ports.reconcileSupported?.()).toBe(true);
    clientState.applyCompat(ORIGIN, { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 1, serverTooOld: false, nativeLoginVerified: false });
    expect(ports.reconcileSupported?.()).toBe(false);
  });

  it('a refusal as unsupported turns the check off for that server only', () => {
    const clientState = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
    const ports = contractPorts({ clientState, refreshCompat: () => Promise.resolve() }, ORIGIN);
    ports.onReconcileUnsupported?.();
    expect(ports.reconcileSupported?.()).toBe(false);
    expect(factsFor(clientState.store.get(), 'https://other.example.test').reconcileSupported).toBeNull();
  });
});

describe('the first look at the server is bounded end to end', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a server that never answers ends the look at the launch timeout (5 s), not at the 10 s default, and changes no fact', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const world = await createWorld({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const ports = contractPorts(world.services, world.server.origin);
    let done = false;
    const look = ports.beforeLaunch?.().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(LAUNCH_COMPAT_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await look;
    expect(done).toBe(true);
    expect(aborted).toBe(true);
    expect(factsFor(world.services.clientState.store.get(), world.server.origin)).toMatchObject({ serverTooOld: false, compatKnown: false, upgrade: 'none' });
    expect(world.services.clientState.store.get().refreshes).toBe(1);
  });
});
