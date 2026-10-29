import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { registerProtocolClient } from './protocol-client.ts';

describe('protocol client registration', () => {
  it('registers the packaged protocol and removes it during clean shutdown', () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      removeAsDefaultProtocolClient: vi.fn(() => true),
    };
    const remove = registerProtocolClient({ app, packaged: true, execPath: 'electron.exe', argv: ['app.cjs'] });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('io.inspectorhub.app');
    remove();
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('io.inspectorhub.app');
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
