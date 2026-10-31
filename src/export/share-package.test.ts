import { describe, expect, it } from 'vitest';
import { IpcError, type DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { ClientPlatform } from '../app/compose';
import { writeAndShare } from './share-package';
import { createExportFiles, createFakeSharer, createManualTimers } from './test-support/world';
import { createDesktopSharer } from '../desktop/sharer-desktop.ts';

async function* chunks(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1, 2, 3]);
}

async function run(platform: ClientPlatform) {
  const files = createExportFiles();
  const timers = createManualTimers();
  const result = await writeAndShare({ files, sharer: createFakeSharer(files), platform, timers }, 'export.zip', chunks());
  return { files, timers, result };
}

describe('writeAndShare by platform', () => {
  it('windows deletes the file as soon as the dialog returns and schedules nothing', async () => {
    const { files, timers, result } = await run('windows');
    expect(result).toEqual({ result: 'shared', kept: false, leftover: false });
    expect(files.cacheNames()).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });

  it('windows deletes the cache file once after the real desktop sharer reports a failed save', async () => {
    const files = createExportFiles();
    const removeCache = files.removeCache.bind(files);
    let removeCount = 0;
    files.removeCache = async (name) => { removeCount += 1; await removeCache(name); };
    const sharer = createDesktopSharer({ dialogs: { saveExport: async () => { throw new IpcError('disk-full'); } } } as Pick<DesktopBridge, 'dialogs'>);
    await expect(writeAndShare({ files, sharer, platform: 'windows' }, 'export.zip', chunks())).rejects.toThrow('The share sheet could not be opened');
    expect(removeCount).toBe(1);
    expect(files.cacheNames()).toEqual([]);
  });

  it('control: android keeps the file and schedules its deletion', async () => {
    const { files, timers, result } = await run('android');
    expect(result).toMatchObject({ kept: true });
    expect(files.cacheNames()).toEqual(['export.zip']);
    expect(timers.pending()).toHaveLength(1);
  });
});
