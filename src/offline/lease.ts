import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';

/**
 * The one lease the flows that talk to the server about local data share: outbox replay, reconcile and
 * package refresh. A DB row, not an in-memory flag, so it survives being asked from two places and expires on
 * its own when its holder hangs or the process dies.
 */
export const SYNC_LEASE = 'sync';
export const DEFAULT_LEASE_TTL_MS = 60_000;
/**
 * A lease that claims to outlive any ttl we would grant by more than this is the work of a clock that was set
 * back after it was written, and is treated as expired.
 */
const MAX_PLAUSIBLE_TTL_MS = 3_600_000;

export interface LeaseHandle {
  /**
   * Extends the lease by its ttl. Resolves false when the lease is no longer ours (it expired and someone else
   * took it, or it was cleared): the work must stop at once and make no further request.
   */
  renew(): Promise<boolean>;
}

export type LeaseResult<T> = { acquired: true; value: T } | { acquired: false };

export interface LeaseOptions {
  clock: Clock;
  ttlMs?: number;
  /** A fresh token per acquisition; two acquisitions are never the same holder. */
  newToken?: () => string;
}

function defaultToken(): string {
  return crypto.randomUUID();
}

/** Takes the lease when it is free, expired or implausible. Returns the token, or null when someone else holds it. */
export async function acquireLease(db: Db, name: string, options: LeaseOptions): Promise<string | null> {
  const ttl = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.clock.now();
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ holder: string; expires_at: number }>('SELECT holder, expires_at FROM lease WHERE name = ?', [name]);
    const held = rows[0];
    if (held !== undefined && held.expires_at > now && held.expires_at - now <= MAX_PLAUSIBLE_TTL_MS) return null;
    const token = (options.newToken ?? defaultToken)();
    await tx.run('INSERT INTO lease (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at', [name, token, now + ttl]);
    return token;
  });
}

/** Extends the lease when `token` is still the holder on record, even one whose ttl just ran out: nobody has taken it, so nobody is displaced. */
export async function renewLease(db: Db, name: string, token: string, options: LeaseOptions): Promise<boolean> {
  const ttl = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = options.clock.now();
  const result = await db.run('UPDATE lease SET expires_at = ? WHERE name = ? AND holder = ?', [now + ttl, name, token]);
  return result.changes === 1;
}

/** Releases the lease when `token` still holds it; a lease someone else took over is left alone. */
export async function releaseLease(db: Db, name: string, token: string): Promise<void> {
  await db.run('DELETE FROM lease WHERE name = ? AND holder = ?', [name, token]);
}

/**
 * Runs `fn` while holding the named lease, or reports `{ acquired: false }` without running it. The lease is
 * released when `fn` ends, however it ends. `fn` must call `renew()` between its steps (before each network
 * request); a request itself is bounded by the http timeout, which is far below the ttl, so a holder that keeps
 * working never loses the lease and a holder that hangs loses it after the ttl.
 */
export async function withLease<T>(db: Db, name: string, options: LeaseOptions, fn: (lease: LeaseHandle) => Promise<T>): Promise<LeaseResult<T>> {
  const token = await acquireLease(db, name, options);
  if (token === null) return { acquired: false };
  try {
    return { acquired: true, value: await fn({ renew: () => renewLease(db, name, token, options) }) };
  } finally {
    await releaseLease(db, name, token).catch(() => undefined);
  }
}
