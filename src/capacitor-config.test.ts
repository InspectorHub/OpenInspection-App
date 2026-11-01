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
