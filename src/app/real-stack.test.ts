import { describe, expect, it, vi } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { createMemoryKeyValue } from '../platform/kv';
import { createClientState } from './client-state';
import { contractPorts, LAUNCH_COMPAT_TIMEOUT_MS } from './real-stack';

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
    expect(clientState.store.get().upgrade).toBe('required');
    expect(ports.serverTooOld?.get()).toBe(false);
  });
});
