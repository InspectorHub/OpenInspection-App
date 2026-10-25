import { Share } from '@capacitor/share';
import type { Files } from '../platform/files';

/** What hands a file to the system share sheet. */
export interface Sharer {
  /** Resolves when the sheet is done with the file. Rejects when it was dismissed or could not open. */
  share(uri: string): Promise<void>;
}

export type ShareResult = 'shared' | 'cancelled';

/** The sheet's title; no customer data. */
const SHEET_TITLE = 'Export unsent data';

export function createRealSharer(): Sharer {
  return {
    share: async (uri) => {
      await Share.share({ title: SHEET_TITLE, dialogTitle: SHEET_TITLE, files: [uri] });
    },
  };
}

/** The plugin rejects with a message containing "canceled" (Android) or "cancelled" when the person closes the sheet. */
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
  /** The cache file could not be deleted. It is swept the next time the app starts or an export begins. */
  leftover: boolean;
}

/**
 * Streams the archive into one file in the OS cache directory, opens the share sheet on it, and deletes the file when the sheet
 * returns, whatever the sheet answered (shared, cancelled, failed) and whatever happened while writing. The cache is the one
 * place chosen on purpose: it is not backed up and the system may clear it, which is where a file full of customer data belongs.
 *
 * A write that fails rejects with the write's own error (the partly written file has already been removed by the file layer);
 * a share that fails for any reason except a cancel rejects with `ShareFailed`.
 */
export async function writeAndShare(deps: { files: Pick<Files, 'writeCacheChunks' | 'removeCache'>; sharer: Sharer }, name: string, chunks: AsyncIterable<Uint8Array>): Promise<WriteAndShareResult> {
  let written = false;
  let result: ShareResult = 'shared';
  let failure: ShareFailed | null = null;
  let leftover = false;
  try {
    const uri = await deps.files.writeCacheChunks(name, chunks);
    written = true;
    try {
      await deps.sharer.share(uri);
    } catch (error) {
      if (isShareCancel(error)) result = 'cancelled';
      else failure = new ShareFailed({ cause: error });
    }
  } finally {
    // Also after a failed write: a file that was created before the failure must not stay behind.
    try {
      await deps.files.removeCache(name);
    } catch {
      // A file that was never created has nothing to remove; one that was created and could not be removed is reported.
      leftover = written;
    }
  }
  if (failure) throw failure;
  return { result, leftover };
}
