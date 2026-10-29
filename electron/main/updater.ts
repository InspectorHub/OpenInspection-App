import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdaterState } from '../shared/ipc-contract.ts';

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterHost {
  state(): UpdaterState;
  check(): Promise<void>;
  download(): Promise<void>;
  installAndRestart(): Promise<'restarting' | 'blocked-uploads'>;
  onState(listener: (state: UpdaterState) => void): () => void;
}

export interface UpdaterTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const INITIAL_CHECK_MS = 30_000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const VERIFY_ERROR_CODES = new Set([
  'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_SIGNATURE_VERIFICATION_FAILED',
  'ERR_UPDATER_INVALID_UPDATE_INFO',
]);
const NETWORK_ERROR_CODES = new Set(['ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function updaterError(error: unknown): 'network' | 'verify' | 'other' {
  const code = errorCode(error);
  if (code !== null && VERIFY_ERROR_CODES.has(code)) return 'verify';
  if ((code !== null && NETWORK_ERROR_CODES.has(code)) || (typeof error === 'object' && error !== null && 'message' in error && /network|fetch|socket/i.test(String((error as { message: unknown }).message)))) return 'network';
  return 'other';
}

function updateVersion(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('version' in value)) return 'unknown';
  const version = (value as { version?: unknown }).version;
  return typeof version === 'string' && version.length <= 64 && /^[0-9A-Za-z.+-]+$/.test(version) ? version : 'unknown';
}

export function readBuildMeta(appPath: string): { oiSigned: boolean } {
  try {
    const value: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'));
    return { oiSigned: typeof value === 'object' && value !== null && 'oiSigned' in value && (value as { oiSigned?: unknown }).oiSigned === true };
  } catch {
    return { oiSigned: false };
  }
}

export function createUpdaterHost(deps: {
  autoUpdater: AutoUpdaterLike;
  enabled: boolean;
  packaged: boolean;
  uploads(): number;
  shutdown(): Promise<void>;
  timers: UpdaterTimerPort;
  random: () => number;
  log(code: string): void;
}): UpdaterHost {
  const { autoUpdater } = deps;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  const enabled = deps.enabled && deps.packaged;
  let current: UpdaterState = enabled ? { kind: 'idle' } : { kind: 'disabled', reason: deps.packaged ? 'unsigned' : 'dev' };
  const listeners = new Set<(state: UpdaterState) => void>();
  let operation: Promise<void> | null = null;
  let failedDuringOperation = false;
  let nextTimer: unknown;

  const publish = (state: UpdaterState): void => {
    current = state;
    for (const listener of listeners) {
      try { listener(current); } catch { deps.log('updater-listener-failed'); }
    }
  };

  const scheduleNext = (): void => {
    if (!enabled) return;
    const random = Math.max(0, Math.min(1, deps.random()));
    const delay = SIX_HOURS_MS * (0.9 + random * 0.2);
    nextTimer = deps.timers.setTimeout(() => { void check(); }, delay);
  };

  const setFailure = (error: unknown): void => {
    const code = updaterError(error);
    deps.log(`updater-${code}`);
    publish({ kind: 'error', code });
  };

  const check = async (): Promise<void> => {
    if (!enabled || operation !== null || current.kind === 'downloading' || current.kind === 'ready') return;
    publish({ kind: 'checking' });
    failedDuringOperation = false;
    operation = (async () => {
      try { await autoUpdater.checkForUpdates(); }
      catch (error) { if (!failedDuringOperation) setFailure(error); }
      finally { operation = null; scheduleNext(); }
    })();
    await operation;
  };

  autoUpdater.on('checking-for-update', () => { if (enabled) publish({ kind: 'checking' }); });
  autoUpdater.on('update-available', (info) => { if (enabled) publish({ kind: 'available', version: updateVersion(info) }); });
  autoUpdater.on('update-not-available', () => { if (enabled) publish({ kind: 'idle' }); });
  autoUpdater.on('download-progress', (progress) => {
    if (!enabled) return;
    const percent = typeof progress === 'object' && progress !== null && 'percent' in progress ? Number((progress as { percent: unknown }).percent) : 0;
    publish({ kind: 'downloading', percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0 });
  });
  autoUpdater.on('update-downloaded', (info) => { if (enabled) publish({ kind: 'ready', version: updateVersion(info) }); });
  autoUpdater.on('error', (error) => { if (enabled) { failedDuringOperation = operation !== null; setFailure(error); } });

  if (enabled) nextTimer = deps.timers.setTimeout(() => { void check(); }, INITIAL_CHECK_MS);

  return {
    state: () => current,
    check,
    async download() {
      if (!enabled || operation !== null || current.kind !== 'available') return;
      publish({ kind: 'downloading', percent: 0 });
      failedDuringOperation = false;
      operation = (async () => {
        try { await autoUpdater.downloadUpdate(); }
        catch (error) { if (!failedDuringOperation) setFailure(error); }
        finally { operation = null; scheduleNext(); }
      })();
      await operation;
    },
    async installAndRestart() {
      if (!enabled || current.kind !== 'ready') throw new Error('update-not-ready');
      if (deps.uploads() > 0) return 'blocked-uploads';
      if (nextTimer !== undefined) deps.timers.clearTimeout(nextTimer);
      try {
        await deps.shutdown();
        autoUpdater.quitAndInstall(false, true);
        return 'restarting';
      } catch (error) {
        setFailure(error);
        throw new Error('update-shutdown-failed');
      }
    },
    onState(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
