import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveStartupPaths } from './paths.ts';

it('ignores packaged test overrides before reading them, and uses them only in development', () => {
  const values = { OI_USER_DATA_DIR: 'test-data', OI_RENDERER_ROOT: 'test-renderer', OI_E2E_HEIC_HELPER: 'test-helper', OI_E2E_NO_HEIC_DECODER: '1' };
  const defaults = { appData: resolve('appdata'), appPath: resolve('app'), packaged: true };
  const guarded = new Proxy(values, { get() { throw new Error('packaged env was read'); } });
  expect(resolveStartupPaths({ ...defaults, env: guarded })).toEqual({ userData: join(defaults.appData, 'InspectorHub'), rendererRoot: join(defaults.appPath, 'dist-electron', 'renderer'), heicHelper: undefined, noHeicDecoder: false });
  expect(resolveStartupPaths({ ...defaults, packaged: false, env: values })).toEqual({ userData: resolve('test-data'), rendererRoot: resolve('test-renderer'), heicHelper: resolve('test-helper'), noHeicDecoder: true });
});
