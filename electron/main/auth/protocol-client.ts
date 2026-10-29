import { resolve } from 'node:path';

export interface ProtocolClientApp {
  setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
  removeAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
}

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
    return () => { options.app.removeAsDefaultProtocolClient(scheme); };
  }
  const args = [resolve(script)];
  options.app.setAsDefaultProtocolClient(scheme, options.execPath, args);
  return () => { options.app.removeAsDefaultProtocolClient(scheme, options.execPath, args); };
}

