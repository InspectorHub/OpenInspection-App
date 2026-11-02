import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IpcError } from '../shared/ipc-contract.ts';
import { createDialogsHost } from './dialogs.ts';

describe('createDialogsHost.saveExport', () => {
  let root: string;
  let cacheRoot: string;
  let downloadsDir: string;
  let source: string;
  let destination: string;
  let showItemInFolder: Mock<(path: string) => void>;
  let showSaveDialog: Mock<(options: unknown) => Promise<{ canceled: boolean; filePath?: string }>>;
  let copyFile: Mock<(source: string, destination: string) => Promise<void>>;
  let dialogs: ReturnType<typeof createDialogsHost>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oi-export-dialog-'));
    cacheRoot = join(root, 'cache');
    downloadsDir = join(root, 'downloads');
    await fs.mkdir(cacheRoot);
    await fs.mkdir(downloadsDir);
    source = join(cacheRoot, 'inspectorhub-export-1700000000000.zip');
    destination = join(downloadsDir, 'offline-copy.zip');
    await writeFile(source, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
    showItemInFolder = vi.fn((_path: string) => {});
    showSaveDialog = vi.fn(async (_options: unknown) => ({ canceled: false, filePath: destination }));
    copyFile = vi.fn((from: string, to: string) => fs.copyFile(from, to));
    dialogs = createDialogsHost({ dialog: { showSaveDialog }, fs: { realpath: fs.realpath, stat: fs.stat, copyFile }, cacheRoot, downloadsDir, showItemInFolder });
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('copies a cache export unchanged to the chosen path and reveals it', async () => {
    const uri = pathToFileURL(source).href;
    await expect(dialogs.saveExport(uri, 'inspectorhub-export-1700000000000.zip')).resolves.toBe('saved');
    expect(showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: join(downloadsDir, 'inspectorhub-export-1700000000000.zip'),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    }));
    expect(await readFile(destination)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]));
    expect(showItemInFolder).toHaveBeenCalledWith(destination);
  });

  it('rejects a file outside the cache root', async () => {
    const outside = join(root, 'outside.zip');
    await writeFile(outside, 'outside');
    await expect(dialogs.saveExport(pathToFileURL(outside).href, 'export.zip')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects UNC file URIs', async () => {
    await expect(dialogs.saveExport('file://server/share/export.zip', 'export.zip')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects a symlink inside cache that resolves outside it', async () => {
    const outside = join(root, 'external');
    await fs.mkdir(outside);
    await writeFile(join(outside, 'inspectorhub-export-1700000000001.zip'), 'outside');
    await symlink(outside, join(cacheRoot, 'external'), 'junction');
    const linked = join(cacheRoot, 'external', 'inspectorhub-export-1700000000001.zip');
    await expect(dialogs.saveExport(pathToFileURL(linked).href, 'export.zip')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it.each(['../escape.zip', 'nested/export.zip', 'export.txt', `${'x'.repeat(101)}.zip`, 'name?.zip'])('rejects an invalid suggested filename: %s', async (name) => {
    await expect(dialogs.saveExport(pathToFileURL(source).href, name)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user dismisses the Save dialog', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });
    await expect(dialogs.saveExport(pathToFileURL(source).href, 'export.zip')).resolves.toBe('cancelled');
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('rejects disk-full and permission failures with fixed IPC error codes', async () => {
    const diskFull = Object.assign(new Error('drive D is full'), { code: 'ENOSPC' });
    copyFile.mockRejectedValueOnce(diskFull);
    await expect(dialogs.saveExport(pathToFileURL(source).href, 'export.zip')).rejects.toMatchObject({ code: 'disk-full' });
    expect(showItemInFolder).not.toHaveBeenCalled();
    const denied = Object.assign(new Error('private path'), { code: 'EACCES' });
    copyFile.mockRejectedValueOnce(denied);
    await expect(dialogs.saveExport(pathToFileURL(source).href, 'export.zip')).rejects.toMatchObject({ code: 'unavailable' });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it('leaves temporary cache cleanup to writeAndShare after a failed save', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    copyFile.mockRejectedValueOnce(Object.assign(new Error(), { code: 'EACCES' }));
    await expect(dialogs.saveExport(pathToFileURL(source).href, 'export.zip')).rejects.toBeInstanceOf(IpcError);
    expect(await fs.access(source).then(() => true, () => false)).toBe(true);
  });
});
