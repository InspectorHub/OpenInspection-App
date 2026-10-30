import { resolve } from 'node:path';

export interface ProtocolClientApp {
  setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
  removeAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
}

/**
 * Registers the sign-in callback scheme and returns the shutdown hook. A packaged build's registration belongs to the
 * installed app and must persist, so a callback that arrives while the app is closed or restarting still opens it;
 * only the unpackaged development registration (which names the Electron executable) is removed again on shutdown.
 */
export function registerProtocolClient(options: {
  app: ProtocolClientApp;
  packaged: boolean;
  execPath: string;
  argv: readonly string[];
  scheme?: string;
}): () => void {
  const scheme = options.scheme ?? 'io.inspectorhub.app';
  const script = options.argv[1];
  if (options.packaged || !script) {
    options.app.setAsDefaultProtocolClient(scheme);
    return () => {};
  }
  const args = [resolve(script)];
  options.app.setAsDefaultProtocolClient(scheme, options.execPath, args);
  return () => { options.app.removeAsDefaultProtocolClient(scheme, options.execPath, args); };
}

