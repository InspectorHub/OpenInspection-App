import { describe, expect, it, vi } from 'vitest';
import { IpcError, type DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import { isShareCancel } from '../export/share-package.ts';
import { createDesktopSharer } from './sharer-desktop.ts';

describe('createDesktopSharer', () => {
  it('resolves when the save dialog saves the export', async () => {
    const saveExport = vi.fn(async () => 'saved' as const);
    const sharer = createDesktopSharer({ dialogs: { saveExport } } as Pick<DesktopBridge, 'dialogs'>);
    await expect(sharer.share('file:///cache/inspectorhub-export-1700000000000.zip')).resolves.toBeUndefined();
    expect(saveExport).toHaveBeenCalledWith('file:///cache/inspectorhub-export-1700000000000.zip', 'inspectorhub-export-1700000000000.zip');
  });

  it('turns an actual dialog cancellation into the share cancellation recognized by export flow', async () => {
    const sharer = createDesktopSharer({ dialogs: { saveExport: vi.fn(async () => 'cancelled' as const) } } as Pick<DesktopBridge, 'dialogs'>);
    let error: unknown;
    try { await sharer.share('file:///cache/export.zip'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Share canceled');
    expect(isShareCancel(error)).toBe(true);
  });

  it('preserves a fixed save error and does not misreport disk-full as cancellation', async () => {
    const failure = new IpcError('disk-full');
    const sharer = createDesktopSharer({ dialogs: { saveExport: vi.fn(async () => { throw failure; }) } } as Pick<DesktopBridge, 'dialogs'>);
    await expect(sharer.share('file:///cache/export.zip')).rejects.toBe(failure);
    expect(isShareCancel(failure)).toBe(false);
  });
});
