import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { createSqlJsDb } from './db-sqljs';
import {
  CURRENT_SCHEMA_VERSION,
  MEDIA_STATES,
  MIGRATIONS,
  OUTBOX_STATES,
  QUARANTINE_SOURCES,
  assertMediaState,
  assertOutboxState,
  assertQuarantineSource,
  migrate,
  readSchemaVersion,
  toUpgradeStatements,
  type Migration,
} from './schema';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
});

async function columns(table: string): Promise<Record<string, ColumnInfo>> {
  const rows = await db.query<ColumnInfo>(`PRAGMA table_info(${table})`);
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

describe('migration list', () => {
  it('starts at version 1 and is strictly ascending with no gaps', () => {
    expect(MIGRATIONS[0]?.toVersion).toBe(1);
    MIGRATIONS.forEach((m, i) => {
      expect(m.toVersion).toBe(i + 1);
      expect(m.statements.length).toBeGreaterThan(0);
    });
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.toVersion);
  });

  it('exposes the same statements to openCapacitorDb as {toVersion, statements}', () => {
    const upgrades = toUpgradeStatements();
    expect(upgrades).toEqual(MIGRATIONS.map((m) => ({ toVersion: m.toVersion, statements: [...m.statements] })));
    for (const u of upgrades) {
      expect(Object.keys(u).sort()).toEqual(['statements', 'toVersion']);
      expect(u.statements.every((s) => typeof s === 'string')).toBe(true);
    }
  });
});

describe('migrate() on the sql.js double', () => {
  it('upgrades an empty database to the current version', async () => {
    expect(await readSchemaVersion(db)).toBe(0);
    const version = await migrate(db, 0);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    expect(await readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      'device_state',
      'media',
      'outbox',
      'resource_cache',
      'work_package',
      'ydoc_updates',
    ]);
  });

  it('creates every table and column with the expected types', async () => {
    await migrate(db, 0);
    const shape = async (table: string) =>
      Object.entries(await columns(table)).map(([name, c]) => [name, c.type, c.notnull, c.pk]);

    expect(await shape('device_state')).toEqual([
      ['key', 'TEXT', 0, 1],
      ['value', 'TEXT', 1, 0],
    ]);
    expect(await shape('resource_cache')).toEqual([
      ['key', 'TEXT', 0, 1],
      ['etag', 'TEXT', 0, 0],
      ['body', 'TEXT', 1, 0],
      ['fetched_at', 'INTEGER', 1, 0],
      ['package_id', 'TEXT', 0, 0],
    ]);
    expect(await shape('ydoc_updates')).toEqual([
      ['doc_name', 'TEXT', 1, 0],
      ['id', 'INTEGER', 0, 1],
      ['data', 'BLOB', 1, 0],
    ]);
    expect(await shape('media')).toEqual([
      ['pending_id', 'TEXT', 0, 1],
      ['inspection_id', 'TEXT', 1, 0],
      ['kind', 'TEXT', 1, 0],
      ['path', 'TEXT', 1, 0],
      ['content_type', 'TEXT', 1, 0],
      ['meta', 'TEXT', 1, 0],
      ['state', 'TEXT', 1, 0],
      ['attempts', 'INTEGER', 1, 0],
      ['uploaded_key', 'TEXT', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
    ]);
    expect(await shape('outbox')).toEqual([
      ['idempotency_key', 'TEXT', 0, 1],
      ['seq', 'INTEGER', 1, 0],
      ['op', 'TEXT', 1, 0],
      ['payload', 'TEXT', 1, 0],
      ['state', 'TEXT', 1, 0],
      ['last_error', 'TEXT', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
    ]);
    expect(await shape('work_package')).toEqual([
      ['inspection_id', 'TEXT', 0, 1],
      ['report_id', 'TEXT', 0, 0],
      ['pinned', 'INTEGER', 1, 0],
      ['scheduled_at', 'INTEGER', 0, 0],
      ['completed', 'INTEGER', 1, 0],
      ['refreshed_at', 'INTEGER', 1, 0],
      ['quarantine_source', 'TEXT', 0, 0],
    ]);
    expect((await columns('media')).attempts?.dflt_value).toBe('0');
    expect((await columns('work_package')).pinned?.dflt_value).toBe('0');
    expect((await columns('work_package')).completed?.dflt_value).toBe('0');
  });

  it('creates the ydoc_updates index on (doc_name, id)', async () => {
    await migrate(db, 0);
    const idx = await db.query<{ name: string; seqno: number; cid: number }>(
      "PRAGMA index_info('idx_ydoc_updates_doc')",
    );
    expect(idx.map((i) => i.name)).toEqual(['doc_name', 'id']);
  });

  it('round-trips a BLOB through ydoc_updates.data', async () => {
    await migrate(db, 0);
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['inspection:1', bytes]);
    const rows = await db.query<{ data: Uint8Array }>('SELECT data FROM ydoc_updates WHERE doc_name = ?', [
      'inspection:1',
    ]);
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.data ?? [])).toEqual(Array.from(bytes));
  });

  it('is a no-op when run again at the current version', async () => {
    await migrate(db, 0);
    await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', ['server_url', 'https://x']);
    expect(await migrate(db, CURRENT_SCHEMA_VERSION)).toBe(CURRENT_SCHEMA_VERSION);
    expect(await migrate(db, await readSchemaVersion(db))).toBe(CURRENT_SCHEMA_VERSION);
    expect(await db.query('SELECT key, value FROM device_state')).toEqual([
      { key: 'server_url', value: 'https://x' },
    ]);
  });

  describe('a later migration on an existing database', () => {
    const v2: Migration = {
      toVersion: CURRENT_SCHEMA_VERSION + 1,
      statements: [
        'ALTER TABLE work_package ADD COLUMN note TEXT',
        "UPDATE work_package SET note = 'migrated'",
      ],
    };

    it('runs once against existing rows and preserves their data', async () => {
      await migrate(db, 0);
      await db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned) VALUES (?, ?, ?)', ['i1', 10, 1]);
      await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['i2', 20]);
      expect(await readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      const migrations = [...MIGRATIONS, v2];
      const first = await migrate(db, CURRENT_SCHEMA_VERSION, migrations);
      expect(first).toBe(v2.toVersion);
      expect(await readSchemaVersion(db)).toBe(v2.toVersion);

      const rows = await db.query('SELECT inspection_id, pinned, refreshed_at, note FROM work_package ORDER BY inspection_id');
      expect(rows).toEqual([
        { inspection_id: 'i1', pinned: 1, refreshed_at: 10, note: 'migrated' },
        { inspection_id: 'i2', pinned: 0, refreshed_at: 20, note: 'migrated' },
      ]);

      // Running again is a no-op: ALTER TABLE ADD COLUMN would throw if it ran twice.
      expect(await migrate(db, first, migrations)).toBe(v2.toVersion);
      expect(await migrate(db, await readSchemaVersion(db), migrations)).toBe(v2.toVersion);
      expect(await db.query('SELECT count(*) AS n FROM work_package')).toEqual([{ n: 2 }]);
    });

    it('does not apply an earlier migration again when upgrading from version 1', async () => {
      await migrate(db, 0, [MIGRATIONS[0] as Migration]);
      expect(await readSchemaVersion(db)).toBe(1);
      await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', ['role', 'inspector']);
      expect(await migrate(db, 1, [...MIGRATIONS, v2])).toBe(v2.toVersion);
      expect(await db.query('SELECT value FROM device_state WHERE key = ?', ['role'])).toEqual([{ value: 'inspector' }]);
    });

    it('rolls back a failing migration and keeps the previous version', async () => {
      await migrate(db, 0);
      const broken: Migration = {
        toVersion: CURRENT_SCHEMA_VERSION + 1,
        statements: ['ALTER TABLE work_package ADD COLUMN half_done TEXT', 'ALTER TABLE no_such_table ADD COLUMN x TEXT'],
      };
      await expect(migrate(db, CURRENT_SCHEMA_VERSION, [...MIGRATIONS, broken])).rejects.toThrow();
      expect(await readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(Object.keys(await columns('work_package'))).not.toContain('half_done');
    });
  });
});

describe('application-level state validators', () => {
  it('lists the media states from the plan', () => {
    expect([...MEDIA_STATES]).toEqual(['pending', 'uploading', 'uploaded', 'failed']);
  });

  it.each(['pending', 'uploading', 'uploaded', 'failed'])('accepts media state %s', (state) => {
    expect(() => {
      assertMediaState(state);
    }).not.toThrow();
  });

  it.each(['', 'PENDING', 'done', 'orphaned', 'upload'])('rejects media state %j', (state) => {
    expect(() => {
      assertMediaState(state);
    }).toThrow(/media state/i);
  });

  it('rejects non-string media states', () => {
    expect(() => {
      assertMediaState(undefined);
    }).toThrow(/media state/i);
    expect(() => {
      assertMediaState(null);
    }).toThrow(/media state/i);
  });

  it.each(['pending', 'failed', 'orphaned'])('accepts outbox state %s', (state) => {
    expect(() => {
      assertOutboxState(state);
    }).not.toThrow();
  });

  it('lists exactly the outbox states derived from the plan', () => {
    expect([...OUTBOX_STATES]).toEqual(['pending', 'failed', 'orphaned']);
  });

  it.each(['', 'done', 'uploading', 'Failed'])('rejects outbox state %j', (state) => {
    expect(() => {
      assertOutboxState(state);
    }).toThrow(/outbox state/i);
  });

  it('accepts reconcile_missing and NULL as a quarantine source', () => {
    expect([...QUARANTINE_SOURCES]).toEqual(['reconcile_missing']);
    expect(() => {
      assertQuarantineSource('reconcile_missing');
    }).not.toThrow();
    expect(() => {
      assertQuarantineSource(null);
    }).not.toThrow();
  });

  it.each(['import_refused', '', 'RECONCILE_MISSING', 'quarantined'])('rejects quarantine source %j', (source) => {
    expect(() => {
      assertQuarantineSource(source);
    }).toThrow(/quarantine source/i);
  });

  it('rejects an undefined quarantine source (NULL must be explicit)', () => {
    expect(() => {
      assertQuarantineSource(undefined);
    }).toThrow(/quarantine source/i);
  });
});
