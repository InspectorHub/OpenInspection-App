import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { assertOutboxState, type OutboxErrorCode, type OutboxState } from '../platform/schema';
import { DEFAULT_REGISTRY, validateCommand, type CommandRegistry } from './registry';

const MAX_ACCOUNT_ID_LENGTH = 256;
const SEQ_KEY = 'outbox_seq';

/** The signed-in account a queued write belongs to. Both parts come from the verified session. */
export interface Account {
  tenantId: string;
  userId: string;
}

export type OutboxFailure = 'enqueue_failed' | 'id_in_use' | 'invalid_account' | 'blocked';

/** Carries a fixed code only. A refused enqueue means the write was NOT stored: the caller keeps the user's input. */
export class OutboxError extends Error {
  constructor(
    readonly code: OutboxFailure,
    options?: { cause?: unknown },
  ) {
    super(`Outbox refused the write: ${code}`, options);
    this.name = 'OutboxError';
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ACCOUNT_ID_LENGTH;
}

export function assertAccount(account: Account): void {
  if (!validId(account.tenantId) || !validId(account.userId)) throw new OutboxError('invalid_account');
}

export function sameAccount(a: Account, tenantId: string | null, userId: string | null): boolean {
  return tenantId === a.tenantId && userId === a.userId;
}

/**
 * The cache and the queue key two accounts apart by this string. Both parts are percent-encoded, so no pair of
 * distinct (tenant, user) can produce the same key.
 */
export function accountKey(account: Account): string {
  return `${encodeURIComponent(account.tenantId)}:${encodeURIComponent(account.userId)}`;
}

export interface OutboxRow {
  idempotencyKey: string;
  seq: number;
  op: string;
  /** The stored JSON text, unparsed: a corrupt row must stay readable. */
  payload: string;
  state: OutboxState;
  lastError: string | null;
  createdAt: number;
  inspectionId: string | null;
  registryVersion: number;
  tenantId: string | null;
  userId: string | null;
  attempts: number;
  nextAt: number | null;
}

interface RawRow {
  idempotency_key: string;
  seq: number;
  op: string;
  payload: string;
  state: string;
  last_error: string | null;
  created_at: number;
  inspection_id: string | null;
  registry_version: number;
  tenant_id: string | null;
  user_id: string | null;
  attempts: number;
  next_at: number | null;
}

const COLUMNS = 'idempotency_key, seq, op, payload, state, last_error, created_at, inspection_id, registry_version, tenant_id, user_id, attempts, next_at';

function toRow(raw: RawRow): OutboxRow {
  assertOutboxState(raw.state);
  return {
    idempotencyKey: raw.idempotency_key,
    seq: raw.seq,
    op: raw.op,
    payload: raw.payload,
    state: raw.state,
    lastError: raw.last_error,
    createdAt: raw.created_at,
    inspectionId: raw.inspection_id,
    registryVersion: raw.registry_version,
    tenantId: raw.tenant_id,
    userId: raw.user_id,
    attempts: raw.attempts,
    nextAt: raw.next_at,
  };
}

export interface OutboxDeps {
  db: Db;
  clock: Clock;
  registry?: CommandRegistry;
  /** Source of local ids and idempotency keys. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|constraint/i.test(error.message);
}

async function nextSeq(tx: Db): Promise<number> {
  const counter = await tx.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [SEQ_KEY]);
  const highest = await tx.query<{ n: number | null }>('SELECT MAX(seq) AS n FROM outbox');
  const stored = Number(counter[0]?.value ?? 0);
  const next = Math.max(Number.isFinite(stored) ? stored : 0, highest[0]?.n ?? 0) + 1;
  await tx.run('INSERT INTO device_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SEQ_KEY, String(next)]);
  return next;
}

/**
 * Queues one write. Validates it against the registry (unknown keys are dropped, an inspection-bound command
 * without a well-formed inspection id is refused), then stores it in ONE short transaction:
 *
 * - `seq` is `max(counter, highest stored seq) + 1`, so a sequence number is never handed out twice even after
 *   the newest row was sent and deleted; a collision on the unique index (another writer) is retried once.
 * - The idempotency key is generated here, once, and is the row's primary key: every attempt to send the row
 *   carries the same key.
 * - For a command that creates the inspection, the local `work_package` row is stored in the same transaction
 *   with `server_confirmed = 0`, so the pair can never be half written.
 *
 * - A write for an inspection that is quarantined or being purged is refused with `OutboxError('blocked')`. The
 *   check reads the package row inside the same transaction that would store the write, so it cannot interleave with
 *   the tombstone's own transaction: a write is either stored before the tombstone or refused after it.
 *
 * Rejects with `RegistryError` (the command is invalid) or `OutboxError` (it could not be stored). Either way
 * nothing was queued and the caller must keep the person's input.
 */
export async function enqueue(deps: OutboxDeps, op: string, input: unknown, options: { account: Account }): Promise<OutboxRow> {
  const { account } = options;
  assertAccount(account);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const { def, payload, inspectionId } = validateCommand(deps.registry ?? DEFAULT_REGISTRY, op, input, newId);
  const text = JSON.stringify(payload);
  const key = newId();
  const createdAt = deps.clock.now();

  const store = (): Promise<OutboxRow> =>
    deps.db.transaction(async (tx) => {
      if (inspectionId !== null) {
        const flags = await tx.query<{ purging: number; quarantine_source: string | null }>('SELECT purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
        const flag = flags[0];
        if (flag !== undefined && (Number(flag.purging) !== 0 || flag.quarantine_source !== null)) throw new OutboxError('blocked');
      }
      if (def.createsInspection === true && inspectionId !== null) {
        const existing = await tx.query<{ tenant_id: string | null; user_id: string | null }>('SELECT tenant_id, user_id FROM work_package WHERE inspection_id = ?', [inspectionId]);
        const owner = existing[0];
        if (owner === undefined) {
          await tx.run('INSERT INTO work_package (inspection_id, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, 0, 0, ?, ?)', [inspectionId, account.tenantId, account.userId]);
        } else if (!sameAccount(account, owner.tenant_id, owner.user_id)) {
          throw new OutboxError('id_in_use');
        }
      }
      const seq = await nextSeq(tx);
      await tx.run(
        `INSERT INTO outbox (idempotency_key, seq, op, payload, state, last_error, created_at, inspection_id, registry_version, tenant_id, user_id, attempts, next_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, 0, NULL)`,
        [key, seq, def.op, text, createdAt, inspectionId, def.registryVersion, account.tenantId, account.userId],
      );
      return {
        idempotencyKey: key,
        seq,
        op: def.op,
        payload: text,
        state: 'pending',
        lastError: null,
        createdAt,
        inspectionId,
        registryVersion: def.registryVersion,
        tenantId: account.tenantId,
        userId: account.userId,
        attempts: 0,
        nextAt: null,
      };
    });

  try {
    return await store();
  } catch (first) {
    if (first instanceof OutboxError) throw first;
    if (!isUniqueViolation(first)) throw new OutboxError('enqueue_failed', { cause: first });
    try {
      return await store();
    } catch (second) {
      if (second instanceof OutboxError) throw second;
      throw new OutboxError('enqueue_failed', { cause: second });
    }
  }
}

export interface OutboxFilter {
  account?: Account;
  inspectionId?: string;
  states?: readonly OutboxState[];
}

function where(filter: OutboxFilter): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.account) {
    parts.push('tenant_id = ? AND user_id = ?');
    params.push(filter.account.tenantId, filter.account.userId);
  }
  if (filter.inspectionId !== undefined) {
    parts.push('inspection_id = ?');
    params.push(filter.inspectionId);
  }
  if (filter.states && filter.states.length > 0) {
    parts.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
    params.push(...filter.states);
  }
  return { clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Rows in queue order (`seq`). */
export async function listOutbox(db: Db, filter: OutboxFilter = {}): Promise<OutboxRow[]> {
  const { clause, params } = where(filter);
  return (await db.query<RawRow>(`SELECT ${COLUMNS} FROM outbox ${clause} ORDER BY seq`, params)).map(toRow);
}

export async function readOutboxRow(db: Db, idempotencyKey: string): Promise<OutboxRow | null> {
  const rows = await db.query<RawRow>(`SELECT ${COLUMNS} FROM outbox WHERE idempotency_key = ?`, [idempotencyKey]);
  return rows[0] ? toRow(rows[0]) : null;
}

export interface OutboxCounts {
  /** Waiting to be sent, including those that wait for a check of their target. */
  pending: number;
  /** Stopped for a person: a permanent refusal or an unreadable row. */
  failed: number;
  /** Their inspection is gone or no longer visible; never sent, kept until the person acts. */
  orphaned: number;
  /** The subset of `pending` whose last attempt found the target not visible (403/404) and awaits a check. */
  needsCheck: number;
}

const EMPTY_COUNTS: OutboxCounts = { pending: 0, failed: 0, orphaned: 0, needsCheck: 0 };

export async function outboxCounts(db: Db, filter: Pick<OutboxFilter, 'account' | 'inspectionId'> = {}): Promise<OutboxCounts> {
  const { clause, params } = where(filter);
  const rows = await db.query<{ state: string; check_n: number; n: number }>(
    `SELECT state, SUM(CASE WHEN last_error = 'target_not_visible' THEN 1 ELSE 0 END) AS check_n, COUNT(*) AS n FROM outbox ${clause} GROUP BY state`,
    params,
  );
  const counts = { ...EMPTY_COUNTS };
  for (const row of rows) {
    if (row.state === 'pending') {
      counts.pending = row.n;
      counts.needsCheck = row.check_n;
    } else if (row.state === 'failed') counts.failed = row.n;
    else if (row.state === 'orphaned') counts.orphaned = row.n;
  }
  return counts;
}

/** Counts per inspection; rows without an inspection id are grouped under the empty string. */
export async function outboxCountsByInspection(db: Db, filter: Pick<OutboxFilter, 'account'> = {}): Promise<Record<string, OutboxCounts>> {
  const { clause, params } = where(filter);
  const rows = await db.query<{ inspection_id: string | null; state: string; n: number }>(
    `SELECT inspection_id, state, COUNT(*) AS n FROM outbox ${clause} GROUP BY inspection_id, state`,
    params,
  );
  const out: Record<string, OutboxCounts> = {};
  for (const row of rows) {
    const key = row.inspection_id ?? '';
    const counts = (out[key] ??= { ...EMPTY_COUNTS });
    if (row.state === 'pending') counts.pending = row.n;
    else if (row.state === 'failed') counts.failed = row.n;
    else if (row.state === 'orphaned') counts.orphaned = row.n;
  }
  return out;
}

/** Rows that need a person: the poisoned ones. */
export async function countFailed(db: Db, filter: Pick<OutboxFilter, 'account'> = {}): Promise<number> {
  return (await outboxCounts(db, filter)).failed;
}

function accountClause(account: Account | undefined): { sql: string; params: unknown[] } {
  return account ? { sql: ' AND tenant_id = ? AND user_id = ?', params: [account.tenantId, account.userId] } : { sql: '', params: [] };
}

/**
 * The reconcile (and only the reconcile) calls this once the server no longer shows the inspection: every
 * PENDING write for it stops being sent and is kept, counted apart from the sendable ones, until the person acts.
 * A failed row is unsent data too, but it already waits for a person with its own code; it stays failed and its
 * code is not overwritten. The marker `target_gone` is what `unorphan` later reverses, and nothing else.
 */
export async function markOrphaned(db: Db, inspectionId: string, account?: Account): Promise<number> {
  const scope = accountClause(account);
  const result = await db.run(
    `UPDATE outbox SET state = 'orphaned', last_error = 'target_gone', next_at = NULL WHERE inspection_id = ? AND state = 'pending'${scope.sql}`,
    [inspectionId, ...scope.params],
  );
  return result.changes;
}

/** The inspection is visible again: its orphaned writes go back to the front of their own line. */
export async function unorphan(db: Db, inspectionId: string, account?: Account): Promise<number> {
  const scope = accountClause(account);
  const result = await db.run(
    `UPDATE outbox SET state = 'pending', last_error = NULL, attempts = 0, next_at = NULL WHERE inspection_id = ? AND state = 'orphaned' AND last_error = 'target_gone'${scope.sql}`,
    [inspectionId, ...scope.params],
  );
  return result.changes;
}

/** Puts a failed row back in line, or makes a waiting row due now. Resolves false when there was nothing to do. */
export async function retryRow(db: Db, idempotencyKey: string): Promise<boolean> {
  const result = await db.run(
    "UPDATE outbox SET state = 'pending', last_error = NULL, attempts = 0, next_at = NULL WHERE idempotency_key = ? AND state IN ('failed', 'pending')",
    [idempotencyKey],
  );
  return result.changes === 1;
}

/**
 * Deletes a queued write for good. The caller must have shown the person the same confirmation as for
 * clearing local data; `confirmed: true` is that promise, and anything else throws.
 */
export async function discardRow(db: Db, idempotencyKey: string, options: { confirmed: true }): Promise<boolean> {
  if (options?.confirmed !== true) throw new Error('discard needs an explicit confirmation');
  const result = await db.run('DELETE FROM outbox WHERE idempotency_key = ?', [idempotencyKey]);
  return result.changes === 1;
}

/** A permanent refusal or unreadable row: stops that inspection's line until a person retries or discards it. */
export async function markFailed(db: Db, idempotencyKey: string, code: OutboxErrorCode): Promise<boolean> {
  const result = await db.run("UPDATE outbox SET state = 'failed', last_error = ?, attempts = 0, next_at = NULL WHERE idempotency_key = ? AND state = 'pending'", [code, idempotencyKey]);
  return result.changes === 1;
}

/** A transient outcome: the row stays pending, remembers why and when it may be tried again. Never counts as failed. */
export async function markWaiting(db: Db, idempotencyKey: string, code: OutboxErrorCode, nextAt: number): Promise<boolean> {
  const result = await db.run("UPDATE outbox SET last_error = ?, attempts = attempts + 1, next_at = ? WHERE idempotency_key = ? AND state = 'pending'", [code, nextAt, idempotencyKey]);
  return result.changes === 1;
}

/**
 * The server accepted the write: the row is deleted and, for a create, the local package is marked confirmed,
 * in one transaction. A crash before this commits leaves the row, which is sent again under the same key; that
 * is safe because every registered command is safe to repeat (a create answers 200 for the existing id).
 */
export async function completeRow(db: Db, row: OutboxRow, confirmsInspection: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM outbox WHERE idempotency_key = ?', [row.idempotencyKey]);
    if (confirmsInspection && row.inspectionId !== null) {
      await tx.run('UPDATE work_package SET server_confirmed = 1 WHERE inspection_id = ? AND tenant_id = ? AND user_id = ?', [row.inspectionId, row.tenantId, row.userId]);
    }
  });
}
