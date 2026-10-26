import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { OfflineStack } from '../../app/offline-stack';
import type { World } from '../../app/test-support/world';
import type { CompatInfo } from '../../auth/server-config';
import { createManualTimers } from '../../collab/test-support/manual-timers';
import { Settings, type SettingsProps } from '../Settings';
import { refreshSummary } from './worklist-render';

export function compat(patch: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, accountUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...patch };
}

export function stackWith(refresh = vi.fn(() => Promise.resolve(refreshSummary({ refreshed: 1 })))): OfflineStack & { refresh: typeof refresh } {
  const mediaReconciler = { idle: () => Promise.resolve(), recheckMissing: vi.fn(), countUnreferenced: () => 0, removeUnreferenced: () => Promise.resolve({ removed: 0, attached: 0, skipped: 0 }) };
  const store = { listRows: () => Promise.resolve([]) };
  return Object.assign({ refresher: { refresh }, mediaReconciler, store } as unknown as OfflineStack, { refresh });
}

export async function open(world: World, props: Partial<SettingsProps> = {}) {
  const services = { ...world.services, openExternal: vi.fn(() => Promise.resolve()) };
  const handlers = { onBack: vi.fn(), onExport: vi.fn(), onSignedOut: vi.fn(), onCleared: vi.fn() };
  render(<Settings services={services} origin={world.server.origin} stack={null} locale="en-US" timers={createManualTimers()} {...handlers} {...props} />);
  return { services, ...handlers };
}

