import { describe, expect, it, vi } from 'vitest';
import config from '../capacitor.config';

describe('capacitor.config.ts', () => {
  it('uses the immutable application id', () => {
    expect(config.appId).toBe('io.inspectorhub.app');
  });

  it('bundles assets and never points the webview at a remote server', () => {
    expect(config.webDir).toBe('dist');
    expect(config.server?.url).toBeUndefined();
  });

  it('never logs: debug builds print plugin call data (secure-store keys, callback URLs) into logcat otherwise', () => {
    expect(config.loggingBehavior).toBe('none');
    expect(config.android?.loggingBehavior).toBeUndefined();
  });

  it('points the webview at the host Vite server only for the one emulator address; every other value leaves server unset', async () => {
    const load = async (value: string | undefined) => {
      vi.resetModules();
      if (value === undefined) vi.unstubAllEnvs();
      else vi.stubEnv('OI_EMULATOR_DEV_SERVER', value);
      return (await import('../capacitor.config')).default.server;
    };
    try {
      // Positive control: the switch works at all, and it is the emulator's own loopback (adb reverse), a secure context, with the pinned Vite port.
      expect(await load('http://localhost:5173')).toEqual({ url: 'http://localhost:5173', cleartext: true });
      for (const value of ['', '1', 'true', 'http://localhost:5174', 'http://localhost:5173/', ' http://localhost:5173', 'https://localhost:5173', 'http://10.0.2.2:5173', 'http://example.com:5173', 'http://127.0.0.1:5173']) {
        expect(await load(value), JSON.stringify(value)).toBeUndefined();
      }
      expect(await load(undefined)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('logs only when OI_NATIVE_LOGGING is exactly "debug"; every other value stays silent', async () => {
    const load = async (value: string | undefined) => {
      vi.resetModules();
      if (value === undefined) vi.unstubAllEnvs();
      else vi.stubEnv('OI_NATIVE_LOGGING', value);
      return (await import('../capacitor.config')).default.loggingBehavior;
    };
    try {
      expect(await load('debug')).toBe('debug'); // positive control: the switch works at all
      for (const value of ['', '1', 'true', 'DEBUG', ' debug', 'debug ', 'production', 'none']) expect(await load(value), JSON.stringify(value)).toBe('none');
      expect(await load(undefined)).toBe('none');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
