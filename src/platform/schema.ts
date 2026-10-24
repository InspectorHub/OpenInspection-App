import type { Db } from './db';
import type { DbUpgrade } from './db-capacitor';

/**
 * One schema step. `statements` is the single source of truth for both paths:
 * `openCapacitorDb` receives them through `toUpgradeStatements()` (the plugin
 * runs them and tracks the version itself), and the sql.js test double runs the
 * very same strings through `migrate()`. Statements must not contain
 * transaction control or `PRAGMA user_version`; each one is a single SQL
 * statement without a trailing semicolon.
 */
export interface Migration {
  toVersion: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    toVersion: 1,
    statements: [
      'CREATE TABLE device_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      `CREATE TABLE resource_cache (
        key TEXT PRIMARY KEY,
        etag TEXT,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        package_id TEXT
      )`,
      `CREATE TABLE ydoc_updates (
        doc_name TEXT NOT NULL,
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL
      )`,
      'CREATE INDEX idx_ydoc_updates_doc ON ydoc_updates(doc_name, id)',
      `CREATE TABLE media (
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
      `CREATE TABLE outbox (
        idempotency_key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE work_package (
        inspection_id TEXT PRIMARY KEY,
        report_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        scheduled_at INTEGER,
        completed INTEGER NOT NULL DEFAULT 0,
        refreshed_at INTEGER NOT NULL,
        quarantine_source TEXT
      )`,
    ],
  },
];

export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.toVersion ?? 0;

/** The shape `openCapacitorDb` hands to the plugin's `addUpgradeStatement`. */
export function toUpgradeStatements(migrations: readonly Migration[] = MIGRATIONS): DbUpgrade[] {
  return migrations.map((m) => ({ toVersion: m.toVersion, statements: [...m.statements] }));
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
 * sql.js double's counterpart of the plugin's upgrade run.
 */
export async function migrate(
  db: Db,
  fromVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number> {
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

/** Keys stored in `device_state`. */
export const DEVICE_STATE_KEYS = [
  'server_url',
  'device_id',
  'client_id',
  'last_verified_at',
  'max_seen_time',
  'offline_max_days',
  'tenant_name',
  'user_id',
  'role',
  'sync_days',
  'locked_reason',
  'install_marker',
] as const;

export type DeviceStateKey = (typeof DEVICE_STATE_KEYS)[number];

export const MEDIA_STATES = ['pending', 'uploading', 'uploaded', 'failed'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

/**
 * The plan names `pending` (queued), `failed` (a 409/422 stops the queue at
 * that entry) and `orphaned` (target inspection no longer visible). A
 * successfully replayed entry is removed, so there is no "sent" state.
 */
export const OUTBOX_STATES = ['pending', 'failed', 'orphaned'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

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
