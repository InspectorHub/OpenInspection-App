import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { registerProtocolClient } from './protocol-client.ts';

describe('protocol client registration', () => {
  it('registers the packaged protocol and keeps it registered through shutdown', () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      removeAsDefaultProtocolClient: vi.fn(() => true),
    };
    const remove = registerProtocolClient({ app, packaged: true, execPath: 'electron.exe', argv: ['app.cjs'] });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('io.inspectorhub.app');
    remove();
    // A sign-in callback that arrives while the app is closed or restarting must still find a registered handler.
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('removes the unpackaged development registration during clean shutdown so it does not outlive the run', () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      removeAsDefaultProtocolClient: vi.fn(() => true),
    };
    const remove = registerProtocolClient({ app, packaged: false, execPath: 'electron.exe', argv: ['electron.exe', 'dist-electron/main/index.cjs'] });
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
    remove();
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('io.inspectorhub.app', 'electron.exe', [resolve('dist-electron/main/index.cjs')]);
  });

  it('registers the development protocol with the executable and app script argument', () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      removeAsDefaultProtocolClient: vi.fn(() => true),
    };
    registerProtocolClient({ app, packaged: false, execPath: 'electron.exe', argv: ['electron.exe', 'dist-electron/main/index.cjs', '--inspect'] });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('io.inspectorhub.app', 'electron.exe', [resolve('dist-electron/main/index.cjs')]);
  });
});
