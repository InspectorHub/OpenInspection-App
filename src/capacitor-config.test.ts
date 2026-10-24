import { describe, expect, it } from 'vitest';
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
});
