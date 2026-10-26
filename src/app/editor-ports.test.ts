import { describe, expect, it } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { createMemoryKeyValue } from '../platform/kv';
import { createClientState } from './client-state';
import { editorPorts } from './editor-ports';

const ORIGIN = 'https://oi.example.test';

function compat(over: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...over };
}

function make(locked = false, tooOld = false) {
  const clientState = createClientState({ kv: createMemoryKeyValue(), appVersion: '1.0.0' });
  const stack = { locked: () => Promise.resolve(locked), serverTooOld: () => tooOld };
  return { clientState, ports: editorPorts({ clientState }, stack, ORIGIN) };
}

describe('editorPorts', () => {
  it('canEdit follows a required update of this server, and only of this server', () => {
    const { clientState, ports } = make();
    expect(ports.canEdit()).toBe(true);
    clientState.applyCompat(ORIGIN, compat({ minSupported: '9.0.0' }));
    expect(ports.canEdit()).toBe(false);
    clientState.applyCompat(ORIGIN, compat());
    expect(ports.canEdit()).toBe(true);
    clientState.applyCompat('https://other.example.test', compat({ minSupported: '9.0.0' }));
    expect(ports.canEdit()).toBe(true);
  });

  it('a recommended update or an old server does not turn editing off', () => {
    const { clientState, ports } = make();
    clientState.applyCompat(ORIGIN, compat({ recommended: '9.0.0', serverTooOld: true }));
    expect(ports.canEdit()).toBe(true);
  });

  it('keeps the lock and the old server apart: an old server leaves the gate open, a lock closes it', async () => {
    const old = make(false, true);
    expect(await old.ports.api.gate()).toBe(true);
    expect(old.ports.api.serverTooOld()).toBe(true);
    const locked = make(true, false);
    expect(await locked.ports.api.gate()).toBe(false);
    expect(locked.ports.api.serverTooOld()).toBe(false);
  });
});
