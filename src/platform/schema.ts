import type { Db } from './db';
import type { DbUpgrade } from './db-capacitor';

/**
 * One schema step. `statements` is the single source of truth for both paths:
 * `openCapacitorDb` receives them through `toUpgradeStatements()` (the plugin
 * runs them and tracks the version itself), and the sql.js test double runs the
 * very same strings through `migrate()`. Statements must not contain
 * transaction control or `PRAGMA user_version`; each one is a single SQL
 * statement without a trailing semicolon.
 *
 * Every statement must be re-runnable (`IF NOT EXISTS`). The plugin commits a
 * migration's statements and only then records its version, outside that
 * transaction; a process kill between the two makes the next open run the same
 * migration again. A later migration that cannot be made idempotent (an
 * `ALTER TABLE ... ADD COLUMN`) needs its own guard for that window.
 */
export interface Migration {
  toVersion: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    toVersion: 1,
    statements: [
      'CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      `CREATE TABLE IF NOT EXISTS resource_cache (
        account_key TEXT NOT NULL,
        key TEXT NOT NULL,
        etag TEXT,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        package_id TEXT,
        PRIMARY KEY (account_key, key)
      )`,
      `CREATE TABLE IF NOT EXISTS ydoc_updates (
        doc_name TEXT NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_ydoc_updates_doc ON ydoc_updates(doc_name, id)',
      'CREATE INDEX IF NOT EXISTS idx_resource_cache_package ON resource_cache(package_id)',
      `CREATE TABLE IF NOT EXISTS media (
        pending_id TEXT PRIMARY KEY,
        inspection_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        meta TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        uploaded_key TEXT,
        created_at INTEGER NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_media_inspection ON media(inspection_id)',
      `CREATE TABLE IF NOT EXISTS outbox (
        idempotency_key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        inspection_id TEXT,
        registry_version INTEGER NOT NULL DEFAULT 1,
        tenant_id TEXT,
        user_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_seq ON outbox(seq)',
      'CREATE INDEX IF NOT EXISTS idx_outbox_inspection ON outbox(inspection_id)',
      'CREATE INDEX IF NOT EXISTS idx_outbox_state_next ON outbox(state, next_at)',
      `CREATE TABLE IF NOT EXISTS work_package (
        inspection_id TEXT PRIMARY KEY,
        report_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        scheduled_at INTEGER,
        completed INTEGER NOT NULL DEFAULT 0,
        refreshed_at INTEGER NOT NULL,
        quarantine_source TEXT,
        server_confirmed INTEGER NOT NULL DEFAULT 1,
        tenant_id TEXT,
        user_id TEXT,
        purging INTEGER NOT NULL DEFAULT 0,
        package_gen INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS ydoc_sync (
        doc_name TEXT PRIMARY KEY,
        covered_state BLOB,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS lease (
        name TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    ],
  },
];

export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.toVersion ?? 0;

/** The shape `openCapacitorDb` hands to the plugin's `addUpgradeStatement`. */
export function toUpgradeStatements(migrations: readonly Migration[] = MIGRATIONS): DbUpgrade[] {
  return migrations.map((m) => ({ toVersion: m.toVersion, statements: [...m.statements] }));
}

/**
 * The database was written by a newer schema than this code knows. Opening it
 * with older code could corrupt it, so open and migrate refuse. The UI layer
 * turns this into a "this app is older than your data" screen that blocks
 * editing but still allows exporting what is on the device.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly codeVersion: number,
  ) {
    super(
      `Database schema version ${String(dbVersion)} is newer than this app supports (${String(codeVersion)}); update the app`,
    );
    this.name = 'SchemaTooNewError';
  }
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.toVersion !== i + 1) {
      throw new Error(
        `Migrations must be contiguous, ascending and start at 1: expected version ${String(i + 1)} at position ${String(i)}, found ${String(m.toVersion)}`,
      );
    }
  });
}

export async function readSchemaVersion(db: Db): Promise<number> {
  const rows = await db.query<{ user_version: number }>('PRAGMA user_version');
  return rows[0]?.user_version ?? 0;
}

/**
 * Applies every migration newer than `fromVersion`, in order, and returns the
 * resulting version. Each migration is its own short transaction together with
 * its version bump, so a failure leaves the previous version intact. Calling it
 * again with the returned (or stored) version applies nothing. This is the
 * sql.js double's counterpart of the plugin's upgrade run. Throws
 * `SchemaTooNewError` when `fromVersion` is newer than the list.
 */
export async function migrate(
  db: Db,
  fromVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
  assertContiguous(migrations);
  const latest = migrations[migrations.length - 1]?.toVersion ?? 0;
  if (fromVersion > latest) throw new SchemaTooNewError(fromVersion, latest);
  let version = fromVersion;
  for (const migration of migrations) {
    if (migration.toVersion <= version) continue;
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) await tx.execute(statement);
      await tx.execute(`PRAGMA user_version = ${String(migration.toVersion)}`);
    });
    version = migration.toVersion;
  }
  return version;
}

/**
 * Exact keys stored in `device_state`. The registered OAuth client id is not
 * one of them: it is stored once per server under `client_id:<origin>` (see
 * `DEVICE_STATE_KEY_PREFIXES`). `user_id`, `tenant_id` and `role` are the
 * signed-in identity the auth layer checks on every sign-in.
 */
export const DEVICE_STATE_KEYS = [
  'server_url',
  'device_id',
  'last_verified_at',
  'max_seen_time',
  'offline_max_days',
  'tenant_name',
  'user_id',
  'tenant_id',
  'role',
  'sync_days',
  'locked_reason',
  'install_marker',
  'outbox_seq',
] as const;

/** Families of per-server keys: the key is the prefix followed by a non-empty suffix. */
export const DEVICE_STATE_KEY_PREFIXES = ['client_id:'] as const;

export type DeviceStateKey = (typeof DEVICE_STATE_KEYS)[number] | `${(typeof DEVICE_STATE_KEY_PREFIXES)[number]}${string}`;

/** True for a declared exact key or a declared prefix followed by something. */
export function isDeviceStateKey(key: string): key is DeviceStateKey {
  if ((DEVICE_STATE_KEYS as readonly string[]).includes(key)) return true;
  return DEVICE_STATE_KEY_PREFIXES.some((prefix) => key.length > prefix.length && key.startsWith(prefix));
}

export function assertDeviceStateKey(key: string): asserts key is DeviceStateKey {
  if (!isDeviceStateKey(key)) throw new Error(`Undeclared device_state key: ${key}`);
}

export const MEDIA_STATES = ['pending', 'uploading', 'uploaded', 'failed'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

/**
 * The plan names `pending` (queued), `failed` (a 409/422 stops the queue at
 * that entry) and `orphaned` (target inspection no longer visible). A
 * successfully replayed entry is removed, so there is no "sent" state.
 */
export const OUTBOX_STATES = ['pending', 'failed', 'orphaned'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/**
 * Fixed vocabulary of `outbox.last_error`. Only these strings are ever stored or shown: the text of a
 * server answer never reaches the row, the log or the screen.
 *
 * `failed` rows carry a permanent code and wait for a person (retry or discard). `pending` rows may carry a
 * transient code (`network`, `server_error`, `rate_limited`, `in_flight`, `target_not_visible`) that only says
 * why the last attempt did not finish; they are retried by the replayer on their own. `orphaned` rows carry
 * `target_gone`.
 */
export const OUTBOX_ERROR_CODES = [
  'corrupt_payload',
  'unknown_op',
  'unknown_registry_version',
  'validation_failed',
  'holiday_blocked',
  'inspection_cancelled',
  'quota_refused',
  'conflict',
  'id_conflict',
  'key_reused',
  'rejected',
  'unexpected_response',
  'network',
  'server_error',
  'rate_limited',
  'in_flight',
  'target_not_visible',
  'target_gone',
] as const;
export type OutboxErrorCode = (typeof OUTBOX_ERROR_CODES)[number];

/** `work_package.quarantine_source`; NULL means the inspection is not quarantined. */
export const QUARANTINE_SOURCES = ['reconcile_missing'] as const;
export type QuarantineSource = (typeof QUARANTINE_SOURCES)[number];

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function assertMediaState(value: unknown): asserts value is MediaState {
  if (!oneOf(MEDIA_STATES, value)) throw new Error(`Invalid media state: ${String(value)}`);
}

export function assertOutboxState(value: unknown): asserts value is OutboxState {
  if (!oneOf(OUTBOX_STATES, value)) throw new Error(`Invalid outbox state: ${String(value)}`);
}

export function assertQuarantineSource(value: unknown): asserts value is QuarantineSource | null {
  if (value === null) return;
  if (!oneOf(QUARANTINE_SOURCES, value)) throw new Error(`Invalid quarantine source: ${String(value)}`);
}
