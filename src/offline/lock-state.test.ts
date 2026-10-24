import { beforeEach, describe, expect, it } from 'vitest';
import { seedLocalData, rowCounts } from '../app/test-support/world';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { DAY_MS } from './lock';
import { evaluateAndPersist, loadLockState, loadTenantName, MAX_TENANT_NAME_LENGTH, recordVerified, setRevoked, touchMaxSeen } from './lock-state';
import { countWaitingUploads } from './waiting';

const NOW = 1_800_000_000_000;
let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function stored(key: string): Promise<string | null> {
  const rows = await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

async function put(key: string, value: string): Promise<void> {
  await db.run('INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)', [key, value]);
}

describe('loadLockState', () => {
  it('an empty device: never verified, nothing seen, no usable limit, not revoked', async () => {
    const loaded = await loadLockState(db);
    expect(loaded.lastVerifiedAt).toBeNull();
    expect(loaded.maxSeenTime).toBe(0);
    expect(Number.isNaN(loaded.offlineMaxDays)).toBe(true);
    expect(loaded.revoked).toBe(false);
  });

  it('parses stored strings into numbers', async () => {
    await put('last_verified_at', String(NOW));
    await put('max_seen_time', String(NOW + 5));
    await put('offline_max_days', '30');
    await put('locked_reason', 'revoked');
    expect(await loadLockState(db)).toEqual({ lastVerifiedAt: NOW, maxSeenTime: NOW + 5, offlineMaxDays: 30, revoked: true });
  });

  it.each(['abc', '', '12.5', '-3', '1e3', '0x10', '99999999999999999999'])('an unparseable stored number %j never becomes a number', async (garbage) => {
    await put('last_verified_at', garbage);
    await put('max_seen_time', garbage);
    await put('offline_max_days', garbage);
    const loaded = await loadLockState(db);
    expect(loaded.lastVerifiedAt).toBeNull();
    expect(loaded.maxSeenTime).toBe(0);
    expect(Number.isNaN(loaded.offlineMaxDays)).toBe(true);
  });

  it('any locked_reason other than revoked is not a revocation', async () => {
    await put('locked_reason', 'expired');
    expect((await loadLockState(db)).revoked).toBe(false);
  });
});

describe('recordVerified', () => {
  it('stores the verification time, the limit, and the latest time seen together', async () => {
    await recordVerified(db, NOW, 14);
    expect(await loadLockState(db)).toEqual({ lastVerifiedAt: NOW, maxSeenTime: NOW, offlineMaxDays: 14, revoked: false });
  });

  it('keeps a later max_seen_time: verifying with a clock that is behind does not move it back', async () => {
    await put('max_seen_time', String(NOW + DAY_MS));
    await recordVerified(db, NOW, 30);
    const loaded = await loadLockState(db);
    expect(loaded.lastVerifiedAt).toBe(NOW);
    expect(loaded.maxSeenTime).toBe(NOW + DAY_MS);
  });

  it('a null limit leaves the stored limit alone (a refresh does not learn it)', async () => {
    await recordVerified(db, NOW, 14);
    await recordVerified(db, NOW + 1000, null);
    expect((await loadLockState(db)).offlineMaxDays).toBe(14);
  });

  it('a limit that is not a positive integer is not stored over a good one', async () => {
    await recordVerified(db, NOW, 14);
    await recordVerified(db, NOW + 1000, Number.NaN);
    await recordVerified(db, NOW + 2000, 1.5);
    expect((await loadLockState(db)).offlineMaxDays).toBe(14);
  });

  it('a server that says 0 is stored as 0 and locks: the device never decides a default', async () => {
    await recordVerified(db, NOW, 0);
    const state = await loadLockState(db);
    expect(state.offlineMaxDays).toBe(0);
    expect((await evaluateAndPersist(db, NOW)).locked).toBe(true);
  });

  it('clears a revocation (the server just accepted this device)', async () => {
    await setRevoked(db);
    expect((await loadLockState(db)).revoked).toBe(true);
    await recordVerified(db, NOW, 30);
    expect((await loadLockState(db)).revoked).toBe(false);
    expect(await stored('locked_reason')).toBeNull();
  });
});

describe('touchMaxSeen', () => {
  it('only ever raises the stored value', async () => {
    await touchMaxSeen(db, 100);
    await touchMaxSeen(db, 50);
    expect(await stored('max_seen_time')).toBe('100');
    await touchMaxSeen(db, 200);
    expect(await stored('max_seen_time')).toBe('200');
  });

  it('is exact for epoch-millisecond values', async () => {
    await touchMaxSeen(db, NOW);
    await touchMaxSeen(db, NOW + 1);
    expect(await stored('max_seen_time')).toBe(String(NOW + 1));
  });
});

describe('setRevoked', () => {
  it('writes through the declared-key check and is idempotent', async () => {
    await setRevoked(db);
    await setRevoked(db);
    expect(await stored('locked_reason')).toBe('revoked');
    const rows = await db.query("SELECT key FROM device_state WHERE key = 'locked_reason'");
    expect(rows).toHaveLength(1);
  });
});

describe('evaluateAndPersist', () => {
  it('persists the new latest time seen on every evaluation, locked or not', async () => {
    await recordVerified(db, NOW, 30);
    expect(await evaluateAndPersist(db, NOW + 1000)).toEqual({ locked: false });
    expect(await stored('max_seen_time')).toBe(String(NOW + 1000));

    await setRevoked(db);
    expect(await evaluateAndPersist(db, NOW + 2000)).toEqual({ locked: true, reason: 'revoked' });
    expect(await stored('max_seen_time')).toBe(String(NOW + 2000));
  });

  it('a wound-back clock locks and does not lower the stored time', async () => {
    await recordVerified(db, NOW, 30);
    await evaluateAndPersist(db, NOW + DAY_MS);
    expect(await evaluateAndPersist(db, NOW)).toEqual({ locked: true, reason: 'clock' });
    expect(await stored('max_seen_time')).toBe(String(NOW + DAY_MS));
  });

  it('after the period passes, locks as expired', async () => {
    await recordVerified(db, NOW, 30);
    expect(await evaluateAndPersist(db, NOW + 30 * DAY_MS)).toEqual({ locked: false });
    expect(await evaluateAndPersist(db, NOW + 31 * DAY_MS)).toEqual({ locked: true, reason: 'expired' });
  });

  it('a verification with the clock still behind keeps the clock lock (the screen must ask for a date fix)', async () => {
    await recordVerified(db, NOW, 30);
    await evaluateAndPersist(db, NOW + DAY_MS);
    const behind = NOW;
    expect(await evaluateAndPersist(db, behind)).toEqual({ locked: true, reason: 'clock' });
    await recordVerified(db, behind, 30);
    expect(await evaluateAndPersist(db, behind)).toEqual({ locked: true, reason: 'clock' });
  });

  it('control: once the clock is no longer behind, the same state unlocks', async () => {
    await recordVerified(db, NOW, 30);
    await evaluateAndPersist(db, NOW + DAY_MS);
    await recordVerified(db, NOW, 30);
    expect(await evaluateAndPersist(db, NOW + DAY_MS + 1000)).toEqual({ locked: false });
  });
});

describe('a locked device never deletes anything', () => {
  it('row counts of every data table are unchanged across lock evaluation, revocation and persistence', async () => {
    await seedLocalData(db);
    const before = await rowCounts(db);
    await recordVerified(db, NOW, 1);
    await setRevoked(db);
    for (const now of [NOW, NOW + 40 * DAY_MS, NOW - DAY_MS]) await evaluateAndPersist(db, now);
    await touchMaxSeen(db, NOW + 1);
    const after = await rowCounts(db);
    for (const table of ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package']) {
      expect(after[table]).toBe(before[table]);
      expect(after[table]).toBe(1);
    }
  });
});

describe('loadTenantName', () => {
  it('is null when nothing is stored, empty, or blank', async () => {
    expect(await loadTenantName(db)).toBeNull();
    await put('tenant_name', '   ');
    expect(await loadTenantName(db)).toBeNull();
  });

  it('returns the stored name trimmed', async () => {
    await put('tenant_name', '  Acme Inspections  ');
    expect(await loadTenantName(db)).toBe('Acme Inspections');
  });

  it('bounds a long name without splitting a character', async () => {
    await put('tenant_name', `${'a'.repeat(MAX_TENANT_NAME_LENGTH - 1)}\u{1F3E0}\u{1F3E0}`);
    const name = await loadTenantName(db);
    expect(Array.from(name ?? '')).toHaveLength(MAX_TENANT_NAME_LENGTH);
    expect(name?.endsWith('\u{1F3E0}')).toBe(true);
  });
});

describe('countWaitingUploads', () => {
  async function addMedia(id: string, state: string): Promise<void> {
    await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'i1', 'photo', `media/${id}.jpg`, 'image/jpeg', '{}', state, 1]);
  }
  async function addOutbox(key: string, seq: number, state: string): Promise<void> {
    await db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)', [key, seq, 'save', '{}', state, 1]);
  }

  it('counts media pending, uploading and failed plus outbox pending and failed', async () => {
    await addMedia('m1', 'pending');
    await addMedia('m2', 'uploading');
    await addMedia('m3', 'failed');
    await addOutbox('o1', 1, 'pending');
    await addOutbox('o2', 2, 'failed');
    expect(await countWaitingUploads(db)).toBe(5);
  });

  it('does not count uploaded media or orphaned outbox rows', async () => {
    await addMedia('m1', 'uploaded');
    await addOutbox('o1', 1, 'orphaned');
    expect(await countWaitingUploads(db)).toBe(0);
  });

  it('an empty device waits for nothing', async () => {
    expect(await countWaitingUploads(db)).toBe(0);
  });
});
