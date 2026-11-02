import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import { createDesktopDiagDeps } from './diag-deps-desktop';

afterEach(() => vi.unstubAllGlobals());

function stubWindow(): void {
  vi.stubGlobal('window', { navigator: { onLine: true }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
}

describe('desktop diagnostics adapters', () => {
  it('checks a missing Windows app file through the desktop Files bridge', async () => {
    stubWindow();
    const exists = vi.fn(async (path: string) => path !== 'media/diag-missing.jpg');
    const deps = createDesktopDiagDeps({ files: { exists } } as unknown as DesktopBridge);
    expect(await deps.ports.statMissing('media/diag-missing.jpg')).toMatchObject({ code: 'NotFound' });
    expect(exists).toHaveBeenCalledWith('media/diag-missing.jpg');
  });

  it('probes collaboration through the renderer WebSocket with the supplied Windows socket URL', async () => {
    stubWindow();
    const urls: string[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor(url: string) { urls.push(url); queueMicrotask(() => this.onopen?.()); }
      close(code = 1000) { queueMicrotask(() => this.onclose?.({ code })); }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const deps = createDesktopDiagDeps({} as DesktopBridge);
    await expect(deps.ports.probeSocket('wss://engine.example/api/inspections/insp-7/collab/ws?ticket=fake', 100)).resolves.toEqual({ opened: true, closeCode: 1000, threw: null });
    expect(urls).toEqual(['wss://engine.example/api/inspections/insp-7/collab/ws?ticket=fake']);
  });
});
