import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { UploaderEventLike, UploaderStartOptions } from '../../electron/shared/ipc-contract.ts';
import type { UploaderEventLike as CapacitorEvent, UploaderStartOptions as CapacitorOptions } from '../platform/uploader.ts';
import { getDesktopBridge } from './bridge.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDesktopBridge', () => {
  it('throws when window.oiDesktop is missing', () => {
    vi.stubGlobal('window', {});
    expect(() => getDesktopBridge()).toThrow(/oiDesktop/);
  });

  it('throws outside a window', () => {
    vi.stubGlobal('window', undefined);
    expect(() => getDesktopBridge()).toThrow(/oiDesktop/);
  });

  it('throws on an api version it does not speak', () => {
    vi.stubGlobal('window', { oiDesktop: { apiVersion: 2 } });
    expect(() => getDesktopBridge()).toThrow(/version/);
  });

  it('returns the bridge the preload script exposed (control)', () => {
    const bridge = { apiVersion: 1 };
    vi.stubGlobal('window', { oiDesktop: bridge });
    expect(getDesktopBridge()).toBe(bridge);
  });
});

describe('the contract uploader types', () => {
  it('stay assignable both ways with the Capacitor uploader types the shared code already speaks', () => {
    expectTypeOf<CapacitorOptions>().toExtend<UploaderStartOptions>();
    expectTypeOf<UploaderStartOptions>().toExtend<CapacitorOptions>();
    expectTypeOf<CapacitorEvent>().toEqualTypeOf<UploaderEventLike>();
  });
});
