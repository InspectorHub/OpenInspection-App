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
  DEVICE_STATE_KEYS,
  DEVICE_STATE_KEY_PREFIXES,
  isDeviceStateKey,
  migrate,
  readSchemaVersion,
  assertSchemaShape,
  EXPECTED_COLUMNS,
  SCHEMA_DRIFT_MESSAGE,
  SchemaDriftError,
  SchemaTooNewError,
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
      'item_tags',
      'lease',
      'media',
      'outbox',
      'resource_cache',
      'work_package',
      'ydoc_updates',
      'ydoc_sync',
    ].sort());
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
      ['account_key', 'TEXT', 1, 1],
      ['key', 'TEXT', 1, 2],
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
      ['inspection_id', 'TEXT', 0, 0],
      ['registry_version', 'INTEGER', 1, 0],
      ['tenant_id', 'TEXT', 0, 0],
      ['user_id', 'TEXT', 0, 0],
      ['attempts', 'INTEGER', 1, 0],
      ['next_at', 'INTEGER', 0, 0],
    ]);
    expect(await shape('work_package')).toEqual([
      ['inspection_id', 'TEXT', 0, 1],
      ['report_id', 'TEXT', 0, 0],
      ['pinned', 'INTEGER', 1, 0],
      ['scheduled_at', 'INTEGER', 0, 0],
      ['completed', 'INTEGER', 1, 0],
      ['refreshed_at', 'INTEGER', 1, 0],
      ['quarantine_source', 'TEXT', 0, 0],
      ['server_confirmed', 'INTEGER', 1, 0],
      ['tenant_id', 'TEXT', 0, 0],
      ['user_id', 'TEXT', 0, 0],
      ['purging', 'INTEGER', 1, 0],
      ['package_gen', 'INTEGER', 1, 0],
    ]);
    expect(await shape('ydoc_sync')).toEqual([
      ['doc_name', 'TEXT', 0, 1],
      ['covered_state', 'BLOB', 0, 0],
      ['updated_at', 'INTEGER', 1, 0],
    ]);
    expect(await shape('lease')).toEqual([
      ['name', 'TEXT', 0, 1],
      ['holder', 'TEXT', 1, 0],
      ['expires_at', 'INTEGER', 1, 0],
    ]);
    expect((await columns('media')).attempts?.dflt_value).toBe('0');
    expect((await columns('work_package')).pinned?.dflt_value).toBe('0');
    expect((await columns('work_package')).completed?.dflt_value).toBe('0');
    expect((await columns('work_package')).server_confirmed?.dflt_value).toBe('1');
    expect((await columns('work_package')).purging?.dflt_value).toBe('0');
    expect((await columns('work_package')).package_gen?.dflt_value).toBe('0');
    expect((await columns('outbox')).registry_version?.dflt_value).toBe('1');
    expect((await columns('outbox')).attempts?.dflt_value).toBe('0');
  });

  it('keys the resource cache per account: the same key under two accounts is two rows', async () => {
    await migrate(db, 0);
    const insert = 'INSERT INTO resource_cache (account_key, key, body, fetched_at) VALUES (?, ?, ?, ?)';
    await db.run(insert, ['t1:u1', 'GET /api/inspections', '[]', 1]);
    await db.run(insert, ['t1:u2', 'GET /api/inspections', '[1]', 1]);
    expect(await db.query('SELECT count(*) AS n FROM resource_cache')).toEqual([{ n: 2 }]);
    await expect(db.run(insert, ['t1:u1', 'GET /api/inspections', '[2]', 2])).rejects.toThrow(/UNIQUE|constraint/i);
    await expect(db.run('INSERT INTO resource_cache (key, body, fetched_at) VALUES (?, ?, ?)', ['k', '{}', 1])).rejects.toThrow(/NOT NULL|constraint/i);
  });

  it('creates the ydoc_updates index on (doc_name, id)', async () => {
    await migrate(db, 0);
    const idx = await db.query<{ name: string; seqno: number; cid: number }>(
      "PRAGMA index_info('idx_ydoc_updates_doc')",
    );
    expect(idx.map((i) => i.name)).toEqual(['doc_name', 'id']);
  });

  it('creates exactly the expected secondary indexes', async () => {
    await migrate(db, 0);
    const indexes = async (table: string) =>
      (await db.query<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${table})`))
        .filter((i) => i.origin === 'c')
        .map((i) => [i.name, i.unique])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(await indexes('ydoc_updates')).toEqual([['idx_ydoc_updates_doc', 0]]);
    expect(await indexes('media')).toEqual([['idx_media_inspection', 0]]);
    expect(await indexes('outbox')).toEqual([
      ['idx_outbox_inspection', 0],
      ['idx_outbox_line', 0],
      ['idx_outbox_seq', 1],
      ['idx_outbox_state_next', 0],
    ]);
    expect(await indexes('resource_cache')).toEqual([['idx_resource_cache_package', 0]]);
    expect(await indexes('device_state')).toEqual([]);
    expect(await indexes('work_package')).toEqual([]);
  });

  describe('outbox constraints and lookups', () => {
    const insert = (key: string, seq: number, inspectionId: string | null) =>
      db.run(
        'INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [key, seq, 'op', '{}', 'pending', 1, inspectionId],
      );
    const planOf = async (sql: string) =>
      (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ['i1'])).map((p) => p.detail).join(' | ');

    it('accepts distinct seq values (positive control)', async () => {
      await migrate(db, 0);
      await insert('k1', 1, 'i1');
      await insert('k2', 2, 'i1');
      expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 2 }]);
    });

    it('rejects two rows with the same seq', async () => {
      await migrate(db, 0);
      await insert('k1', 1, 'i1');
      await expect(insert('k2', 1, 'i2')).rejects.toThrow(/UNIQUE/i);
    });

    it('allows a NULL inspection_id for ops not tied to an inspection', async () => {
      await migrate(db, 0);
      await insert('k1', 1, null);
      expect(await db.query('SELECT inspection_id FROM outbox')).toEqual([{ inspection_id: null }]);
    });

    it('finds outbox rows by inspection_id through the index', async () => {
      await migrate(db, 0);
      await insert('k1', 1, 'i1');
      await insert('k2', 2, 'i2');
      await insert('k3', 3, 'i1');
      const rows = await db.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM outbox WHERE inspection_id = ? ORDER BY seq',
        ['i1'],
      );
      expect(rows.map((r) => r.idempotency_key)).toEqual(['k1', 'k3']);
      expect(await planOf('SELECT idempotency_key FROM outbox WHERE inspection_id = ?')).toContain(
        'idx_outbox_inspection',
      );
    });

    it('finds media rows by inspection_id through the index', async () => {
      await migrate(db, 0);
      expect(await planOf('SELECT pending_id FROM media WHERE inspection_id = ?')).toContain(
        'idx_media_inspection',
      );
    });
  });

  it('can run the whole v1 statement list twice without error and keeps existing data', async () => {
    const statements = MIGRATIONS[0]?.statements ?? [];
    for (const s of statements) await db.execute(s);
    await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', ['role', 'inspector']);
    for (const s of statements) await db.execute(s);
    expect(await db.query('SELECT key, value FROM device_state')).toEqual([{ key: 'role', value: 'inspector' }]);
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

    it('rolls back the schema change when a later statement of the same migration fails', async () => {
      await migrate(db, 0);
      const broken: Migration = {
        toVersion: CURRENT_SCHEMA_VERSION + 1,
        statements: ['ALTER TABLE work_package ADD COLUMN early TEXT', 'INSERT INTO no_such_table VALUES (1)'],
      };
      await expect(migrate(db, CURRENT_SCHEMA_VERSION, [...MIGRATIONS, broken])).rejects.toThrow();
      expect(await readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(Object.keys(await columns('work_package'))).not.toContain('early');
    });

    it('rolls back the schema change when the user_version bump itself fails', async () => {
      await migrate(db, 0);
      const inner = db;
      const failingBump: Db = {
        ...inner,
        transaction: (fn) =>
          inner.transaction((tx) =>
            fn({
              ...tx,
              execute: (sql) =>
                sql.startsWith('PRAGMA user_version') ? Promise.reject(new Error('bump failed')) : tx.execute(sql),
            }),
          ),
      };
      const v2: Migration = {
        toVersion: CURRENT_SCHEMA_VERSION + 1,
        statements: ['ALTER TABLE work_package ADD COLUMN bumped TEXT'],
      };
      await expect(migrate(failingBump, CURRENT_SCHEMA_VERSION, [...MIGRATIONS, v2])).rejects.toThrow('bump failed');
      expect(await readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(Object.keys(await columns('work_package'))).not.toContain('bumped');
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

describe('migrate() guards', () => {
  it('opens a database whose version equals the code version (positive control)', async () => {
    await migrate(db, 0);
    expect(await migrate(db, CURRENT_SCHEMA_VERSION)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('throws SchemaTooNewError when the stored version is higher than the code knows', async () => {
    const err = await migrate(db, CURRENT_SCHEMA_VERSION + 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaTooNewError);
    expect((err as SchemaTooNewError).dbVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect((err as SchemaTooNewError).codeVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('does not touch the database when it is too new', async () => {
    await expect(migrate(db, CURRENT_SCHEMA_VERSION + 1)).rejects.toThrow(SchemaTooNewError);
    expect(await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([]);
  });

  const m = (toVersion: number): Migration => ({ toVersion, statements: ['SELECT 1'] });

  it('accepts a contiguous list starting at 1 (positive control)', async () => {
    expect(await migrate(db, 0, [m(1), m(2), m(3)])).toBe(3);
  });

  it.each([
    ['does not start at 1', [m(2), m(3)]],
    ['has a gap', [m(1), m(3)]],
    ['is not sorted', [m(2), m(1)]],
    ['has a duplicate', [m(1), m(1)]],
  ])('throws when the migrations list %s', async (_label, list) => {
    await expect(migrate(db, 0, list)).rejects.toThrow(/contiguous|ascending|start at 1/i);
  });
});

describe('device_state keys', () => {
  it('lists the keys the auth layer writes as exact keys, and the per-origin client id as a prefix', () => {
    expect(DEVICE_STATE_KEYS).toContain('tenant_id');
    expect(DEVICE_STATE_KEYS).toContain('user_id');
    expect(DEVICE_STATE_KEYS).toContain('role');
    expect([...DEVICE_STATE_KEY_PREFIXES]).toEqual(['client_id:']);
    expect(new Set(DEVICE_STATE_KEYS).size).toBe(DEVICE_STATE_KEYS.length);
  });

  it.each([...DEVICE_STATE_KEYS, 'client_id:https://a.example.com', 'client_id:http://127.0.0.1:8787'])('accepts %s', (key) => {
    expect(isDeviceStateKey(key)).toBe(true);
  });

  it.each(['', 'client_id', 'client_id:', 'Client_id:https://a', ' client_id:https://a', 'client_idx:https://a', 'tenant', 'TENANT_ID', 'refresh_token', 'oi.auth.refresh-token:https://a'])('rejects %j', (key) => {
    expect(isDeviceStateKey(key)).toBe(false);
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

describe('SchemaDriftError: a version 1 database written before the migration was edited in place', () => {
  async function applyVersion1Only(): Promise<void> {
    const first = MIGRATIONS[0];
    if (first === undefined) throw new Error('no version 1 migration');
    await migrate(db, 0, [first]);
  }

  it('the expected columns are exactly what the version 1 migration creates (so the list cannot drift from it)', async () => {
    await applyVersion1Only();
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      expect(Object.keys(await columns(table)).sort(), table).toEqual([...expected].sort());
    }
    expect(Object.keys(EXPECTED_COLUMNS).sort()).toEqual(['outbox', 'resource_cache', 'work_package']);
  });

  it('positive control: the version 1 shape passes', async () => {
    await applyVersion1Only();
    await expect(assertSchemaShape(db)).resolves.toBeUndefined();
  });

  const cases = Object.entries(EXPECTED_COLUMNS).flatMap(([table, names]) => names.map((name) => [table, name] as const));
  it.each(cases)('%s without %s is drift, with the fixed message', async (table, missing) => {
    await migrate(db, 0);
    for (const [other, names] of Object.entries(EXPECTED_COLUMNS)) {
      await db.execute(`DROP TABLE ${other}`);
      const kept = names.filter((name) => !(other === table && name === missing));
      await db.execute(`CREATE TABLE ${other} (${kept.map((name) => `"${name}" TEXT`).join(', ')})`);
    }
    const err = await assertSchemaShape(db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).message).toBe(SCHEMA_DRIFT_MESSAGE);
    expect((err as SchemaDriftError).message).not.toContain(`${table}.${missing}`);
    expect((err as SchemaDriftError).detail).toBe(`${table}.${missing}`);
  });

  it('a missing table is drift', async () => {
    await migrate(db, 0);
    await db.execute('DROP TABLE outbox');
    await expect(assertSchemaShape(db)).rejects.toBeInstanceOf(SchemaDriftError);
  });

  describe('when a version 2 migration adds a column', () => {
    const v2: Migration = { toVersion: 2, statements: ['ALTER TABLE work_package ADD COLUMN note TEXT'] };

    it('a healthy version 1 database waiting for its upgrade still passes the probe (the probe runs before the upgrade)', async () => {
      await applyVersion1Only();
      expect(Object.keys(await columns('work_package'))).not.toContain('note');
      await expect(assertSchemaShape(db)).resolves.toBeUndefined();
    });

    it('the list stays equal to the version 1 shape, not to the newest one', async () => {
      const first = MIGRATIONS[0];
      if (first === undefined) throw new Error('no version 1 migration');
      await migrate(db, 0, [first, v2]);
      expect(Object.keys(await columns('work_package'))).toContain('note');
      expect(EXPECTED_COLUMNS.work_package).not.toContain('note');
      await expect(assertSchemaShape(db)).resolves.toBeUndefined();
    });

    it('an old-shape database still fails the probe (negative control)', async () => {
      await applyVersion1Only();
      await db.execute('DROP TABLE outbox');
      await db.execute('CREATE TABLE outbox (idempotency_key TEXT PRIMARY KEY, seq INTEGER)');
      await expect(assertSchemaShape(db)).rejects.toBeInstanceOf(SchemaDriftError);
    });
  });

  it('the message tells the person what to do', () => {
    expect(SCHEMA_DRIFT_MESSAGE).toBe('This development build has an outdated local database: clear the app data');
  });
});
