import type { ClientPlatform } from '../app/compose';
import { realTimers, type TimerPort } from '../collab/timers';
import type { Files } from '../platform/files';
import { EXPORT_RETAIN_MS } from './format';

/** What hands a file to the system share sheet. */
export interface Sharer {
  /** Resolves when the sheet is done with the file. Rejects when it was dismissed or could not open. */
  share(uri: string): Promise<void>;
}

export type ShareResult = 'shared' | 'cancelled';

/**
 * The plugin rejects with a message containing "canceled" when the person closes the sheet (verified against @capacitor/share 8.0.3:
 * Android and iOS both reject "Share canceled"; iOS rejects "Error sharing item" when the activity itself failed).
 */
export function isShareCancel(error: unknown): boolean {
  const message = typeof error === 'object' && error !== null && 'message' in error ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && /cancel(l)?ed/i.test(message);
}

export class ShareFailed extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The share sheet could not be opened', options);
    this.name = 'ShareFailed';
  }
}

export interface WriteAndShareResult {
  result: ShareResult;
  /** The archive was deliberately left in the cache (Android) and will be removed by the timer or a later sweep. */
  kept: boolean;
  /** The archive should have been deleted now and could not be. It is swept the next time the app starts or an export begins. */
  leftover: boolean;
}

export interface WriteAndShareDeps {
  files: Pick<Files, 'writeCacheChunks' | 'removeCache'>;
  sharer: Sharer;
  platform: ClientPlatform;
  /** Schedules the deletion on Android. Defaults to the page's timers. */
  timers?: TimerPort;
  retainMs?: number;
}

/**
 * Streams the archive into one file in the OS cache directory and opens the share sheet on it. The cache is the one place chosen on
 * purpose: it is not backed up and the system may clear it, which is where a file full of customer data belongs.
 *
 * When the file is deleted depends on the platform. iOS settles the promise only after the activity completed, so the file is
 * deleted as soon as the sheet returns, whatever it answered; so is it on Windows, where the save dialog returns once the file is copied. On Android it is kept for `retainMs` (see `EXPORT_RETAIN_MS`) after
 * the sheet returns, whatever it answered, and then deleted by an in-process timer; every start, foreground return and sign-out also
 * sweeps by age, and the next export sweeps everything. A write that fails removes its partly written file at once, on both.
 *
 * A write that fails rejects with the write's own error; a share that fails for any reason except a cancel rejects with `ShareFailed`.
 */
export async function writeAndShare(deps: WriteAndShareDeps, name: string, chunks: AsyncIterable<Uint8Array>): Promise<WriteAndShareResult> {
  const timers = deps.timers ?? realTimers;
  let written = false;
  let result: ShareResult = 'shared';
  let failure: ShareFailed | null = null;
  let kept = false;
  let leftover = false;

  async function removeNow(): Promise<void> {
    try {
      await deps.files.removeCache(name);
    } catch {
      // A file that was never created has nothing to remove; one that was created and could not be removed is reported.
      leftover = written;
    }
  }

  try {
    const uri = await deps.files.writeCacheChunks(name, chunks);
    written = true;
    try {
      await deps.sharer.share(uri);
    } catch (error) {
      if (isShareCancel(error)) result = 'cancelled';
      else failure = new ShareFailed({ cause: error });
    }
  } catch (error) {
    await removeNow();
    throw error;
  }
  if (deps.platform !== 'android') await removeNow();
  else {
    kept = true;
    try {
      timers.setTimeout(() => {
        deps.files.removeCache(name).catch(() => undefined);
      }, deps.retainMs ?? EXPORT_RETAIN_MS);
    } catch {
      // No timer: the file stays until the next sweep, which is the safe direction.
    }
  }
  if (failure) throw failure;
  return { result, kept, leftover };
}
