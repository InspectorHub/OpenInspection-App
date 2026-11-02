import type { HttpResponse } from '../auth/http';
import type { MediaKind, MediaRow } from './store';
import type { Failure } from './upload-kinds';

export type AuthedResult = { ok: true; res: HttpResponse } | { ok: false; failure: Failure };

/** What a kind's strategy may do on the network: authenticated JSON posts to the pinned origin, and nothing else. */
export interface KindContext {
  /** The stored, canonical server origin. */
  origin: string;
  /**
   * POSTs `body` as JSON to `path` on the pinned origin with the bearer token. A 401 refreshes the session and tries
   * once more; a redirect, a network failure or a signed-out session answers a failure. Never throws.
   */
  post(path: string, body: unknown): Promise<AuthedResult>;
}

export type TransferTarget =
  | {
      ok: true;
      /** Where the plugin sends the file. Held in memory for the one transfer; never stored. */
      url: string;
      /** What the row remembers once the file arrived: enough to finalize, and nothing secret. */
      key: string;
      /** False when the destination is not the app's own server, so it learns nothing about the app or the account. */
      sendClientHeaders: boolean;
    }
  | { ok: false; failure: Failure };

/**
 * What differs between kinds of upload. The photo path is built into the uploader; a strategy adds a kind that needs
 * its own way to obtain a destination and an extra step once the file has arrived.
 */
export interface KindStrategy {
  readonly kind: Exclude<MediaKind, 'photo' | 'crop' | 'annotate'>;
  readonly notificationTitle: string;
  /** The largest file the server accepts. Checked against the file on disk before any request. */
  readonly maxBytes: number;
  /** True for exactly the key this row's upload would produce. */
  isExpectedKey(key: unknown, row: MediaRow): key is string;
  /** Obtains a fresh destination for the row. */
  mint(row: MediaRow, ctx: KindContext): Promise<TransferTarget>;
  /** Runs after the file arrived (a confirmed 2xx for this row's transfer). Must be safe to run again after a kill. */
  complete(row: MediaRow, key: string, ctx: KindContext): Promise<{ ok: true } | { ok: false; failure: Failure }>;
}
