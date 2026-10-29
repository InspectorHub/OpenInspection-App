import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUpdaterHost, readBuildMeta, type AutoUpdaterLike } from './updater.ts';

type EventName = 'checking-for-update' | 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error';
class FakeUpdater implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  listeners = new Map<EventName, Array<(...args: never[]) => void>>();
  checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.2.0' } }));
  downloadUpdate = vi.fn(async () => ['setup.exe']);
  quitAndInstall = vi.fn();
  on(event: EventName, listener: (...args: never[]) => void): this { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
  emit(event: EventName, ...args: never[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
}

function makeTimers() {
  const callbacks: Array<{ fn: () => void; ms: number }> = [];
  return { callbacks, port: { setTimeout: (fn: () => void, ms: number) => { callbacks.push({ fn, ms }); return callbacks.length; }, clearTimeout: vi.fn() } };
}

describe('desktop updater host', () => {
  it('disables unsigned or unpackaged builds and turns off implicit update behavior', () => {
    const unsigned = new FakeUpdater();
    const deps = { autoUpdater: unsigned, enabled: false, packaged: true, uploads: () => 0, shutdown: vi.fn(async () => {}), timers: makeTimers().port, random: () => 0.5, log: vi.fn() };
    const host = createUpdaterHost(deps);
    expect(host.state()).toEqual({ kind: 'disabled', reason: 'unsigned' });
    expect([unsigned.autoDownload, unsigned.autoInstallOnAppQuit, unsigned.allowDowngrade, unsigned.allowPrerelease]).toEqual([false, false, false, false]);
    void host.check();
    expect(unsigned.checkForUpdates).not.toHaveBeenCalled();

    const dev = createUpdaterHost({ ...deps, enabled: true, packaged: false });
    expect(dev.state()).toEqual({ kind: 'disabled', reason: 'dev' });
  });

  it('schedules the initial check at 30 seconds and repeats with plus/minus ten percent jitter', async () => {
    const updater = new FakeUpdater();
    const timers = makeTimers();
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 0, shutdown: async () => {}, timers: timers.port, random: () => 0, log: vi.fn() });
    expect(host.state()).toEqual({ kind: 'idle' });
    expect(timers.callbacks[0]?.ms).toBe(30_000);
    await timers.callbacks[0]?.fn();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(timers.callbacks[1]?.ms).toBe(6 * 60 * 60 * 1000 * 0.9);
  });

  it('broadcasts available, progress and ready states without exposing updater errors', async () => {
    const updater = new FakeUpdater();
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 0, shutdown: async () => {}, timers: makeTimers().port, random: () => 0.5, log: vi.fn() });
    const listener = vi.fn();
    host.onState(listener);
    updater.emit('update-available', { version: '0.2.0' } as never);
    expect(host.state()).toEqual({ kind: 'available', version: '0.2.0' });
    updater.emit('download-progress', { percent: 42.5 } as never);
    expect(host.state()).toEqual({ kind: 'downloading', percent: 42.5 });
    updater.emit('update-downloaded', { version: '0.2.0' } as never);
    expect(host.state()).toEqual({ kind: 'ready', version: '0.2.0' });
    updater.emit('error', Object.assign(new Error('https://secret.example.test/private-feed?token=secret'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }) as never);
    expect(host.state()).toEqual({ kind: 'error', code: 'verify' });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('allows retry after a failed check and keeps logs to fixed error codes', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error('private token in url'), { code: 'ENETUNREACH' }));
    const log = vi.fn();
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 0, shutdown: async () => {}, timers: makeTimers().port, random: () => 0.5, log });
    await host.check();
    expect(host.state()).toEqual({ kind: 'error', code: 'network' });
    expect(log).toHaveBeenCalledWith('updater-network');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private token');
    await host.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('reports a failed download and permits checking again', async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error('private url'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }));
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 0, shutdown: async () => {}, timers: makeTimers().port, random: () => 0.5, log: vi.fn() });
    updater.emit('update-available', { version: '0.2.0' } as never);
    await host.download();
    expect(host.state()).toEqual({ kind: 'error', code: 'verify' });
    await host.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('blocks restart while uploads are active without shutting down or quitting', async () => {
    const updater = new FakeUpdater();
    const shutdown = vi.fn(async () => {});
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 1, shutdown, timers: makeTimers().port, random: () => 0.5, log: vi.fn() });
    updater.emit('update-downloaded', { version: '0.2.0' } as never);
    await expect(host.installAndRestart()).resolves.toBe('blocked-uploads');
    expect(shutdown).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('shuts down before installing and restarting when no uploads remain', async () => {
    const order: string[] = [];
    const updater = new FakeUpdater();
    updater.quitAndInstall.mockImplementation(() => { order.push('quitAndInstall'); });
    const host = createUpdaterHost({ autoUpdater: updater, enabled: true, packaged: true, uploads: () => 0, shutdown: async () => { order.push('shutdown'); }, timers: makeTimers().port, random: () => 0.5, log: vi.fn() });
    updater.emit('update-downloaded', { version: '0.2.0' } as never);
    await expect(host.installAndRestart()).resolves.toBe('restarting');
    expect(order).toEqual(['shutdown', 'quitAndInstall']);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('reads only the oiSigned build flag from package metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oi-updater-meta-'));
    try {
      await mkdir(join(root, 'resources'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.1', extraMetadata: { oiSigned: true, token: 'not-used' } }));
      expect(readBuildMeta(root)).toEqual({ oiSigned: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }));
      expect(readBuildMeta(root)).toEqual({ oiSigned: false });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
