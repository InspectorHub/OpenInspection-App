import { join, resolve } from 'node:path';

export function resolveStartupPaths(deps: { packaged: boolean; appData: string; appPath: string; env: Readonly<Record<string, string | undefined>> }): {
  userData: string; rendererRoot: string; heicHelper: string | undefined; noHeicDecoder: boolean;
} {
  const overrides: Readonly<Record<string, string | undefined>> = deps.packaged ? {} : deps.env;
  return {
    userData: overrides.OI_USER_DATA_DIR ? resolve(overrides.OI_USER_DATA_DIR) : join(deps.appData, 'InspectorHub'),
    rendererRoot: overrides.OI_RENDERER_ROOT ? resolve(overrides.OI_RENDERER_ROOT) : join(deps.appPath, 'dist-electron', 'renderer'),
    heicHelper: overrides.OI_E2E_HEIC_HELPER ? resolve(overrides.OI_E2E_HEIC_HELPER) : undefined,
    noHeicDecoder: overrides.OI_E2E_NO_HEIC_DECODER === '1',
  };
}
