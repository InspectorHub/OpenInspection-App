import { describe, expect, it } from 'vitest';
import {
  type DbChanges,
  decodeRow,
  encodeParams,
  openCapacitorDb,
  type SqliteConnectionLike,
  type SqliteDbConnectionLike,
  wrapConnection,
} from './db-capacitor';

class FakeConn implements SqliteDbConnectionLike {
  calls: string[] = [];
  failRunWith: Error | null = null;
  queryRows: unknown[] = [];

  open() {
    this.calls.push('open');
    return Promise.resolve();
  }
  execute(sql: string, tx?: boolean) {
    this.calls.push(`execute:${sql}:${String(tx)}`);
    return Promise.resolve<DbChanges>({});
  }
  query(sql: string, values?: unknown[]) {
    this.calls.push(`query:${sql}:${JSON.stringify(values)}`);
    return Promise.resolve({ values: this.queryRows });
  }
  run(sql: string, values?: unknown[], tx?: boolean) {
    this.calls.push(`run:${sql}:${JSON.stringify(values)}:${String(tx)}`);
    if (this.failRunWith) return Promise.reject(this.failRunWith);
    return Promise.resolve<DbChanges>({ changes: { changes: 1, lastId: 7 } });
  }
  beginTransaction() {
    this.calls.push('begin');
    return Promise.resolve<DbChanges>({});
  }
  commitTransaction() {
    this.calls.push('commit');
    return Promise.resolve<DbChanges>({});
  }
  rollbackTransaction() {
    this.calls.push('rollback');
    return Promise.resolve<DbChanges>({});
  }
}

class FakeSqlite implements SqliteConnectionLike {
  calls: string[] = [];
  secretStored = false;
  hasConnection = false;
  secret: string | null = null;
  conn = new FakeConn();

  isSecretStored() {
    this.calls.push('isSecretStored');
    return Promise.resolve({ result: this.secretStored });
  }
  setEncryptionSecret(s: string) {
    this.calls.push('setEncryptionSecret');
    this.secret = s;
    return Promise.resolve();
  }
  checkConnectionsConsistency() {
    this.calls.push('checkConnectionsConsistency');
    return Promise.resolve({ result: true });
  }
  isConnection() {
    this.calls.push('isConnection');
    return Promise.resolve({ result: this.hasConnection });
  }
  retrieveConnection() {
    this.calls.push('retrieveConnection');
    return Promise.resolve(this.conn);
  }
  createConnection(name: string, enc: boolean, mode: string, version: number, ro: boolean) {
    this.calls.push(`createConnection:${name}:${String(enc)}:${mode}:${String(version)}:${String(ro)}`);
    return Promise.resolve(this.conn);
  }
  addUpgradeStatement(name: string) {
    this.calls.push(`addUpgradeStatement:${name}`);
    return Promise.resolve();
  }
}

const opts = {
  name: 'oi',
  version: 2,
  upgrades: [
    { toVersion: 1, statements: ['A'] },
    { toVersion: 2, statements: ['B'] },
  ],
};

describe('openCapacitorDb', () => {
  it('provisions the secret once, registers upgrades before createConnection, then opens', async () => {
    const sqlite = new FakeSqlite();
    await openCapacitorDb(sqlite, { ...opts, generateSecret: () => 'sekret' });
    expect(sqlite.secret).toBe('sekret');
    expect(sqlite.calls).toEqual([
      'isSecretStored',
      'setEncryptionSecret',
      'checkConnectionsConsistency',
      'addUpgradeStatement:oi',
      'isConnection',
      'createConnection:oi:true:secret:2:false',
    ]);
    expect(sqlite.conn.calls).toEqual(['open']);
  });

  it('does not overwrite an existing secret and reuses an existing connection', async () => {
    const sqlite = new FakeSqlite();
    sqlite.secretStored = true;
    sqlite.hasConnection = true;
    await openCapacitorDb(sqlite, opts);
    expect(sqlite.calls).not.toContain('setEncryptionSecret');
    expect(sqlite.calls).toContain('retrieveConnection');
    expect(sqlite.calls.some((c) => c.startsWith('createConnection'))).toBe(false);
  });

  it('generates a 64-char hex secret by default', async () => {
    const sqlite = new FakeSqlite();
    await openCapacitorDb(sqlite, opts);
    expect(sqlite.secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('wrapConnection', () => {
  it('passes transaction=false to run and execute inside a manual transaction, and commits', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn);
    await db.transaction(async (tx) => {
      await tx.run('INSERT 1', [1]);
      await tx.execute('DDL');
    });
    expect(conn.calls).toEqual(['begin', 'run:INSERT 1:[1]:false', 'execute:DDL:false', 'commit']);
  });

  it('uses the plugin default transaction handling outside a manual transaction', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn);
    await db.run('INSERT 1', [1]);
    expect(conn.calls).toEqual(['run:INSERT 1:[1]:undefined']);
  });

  it('rolls back explicitly and rethrows when a statement fails', async () => {
    const conn = new FakeConn();
    conn.failRunWith = new Error('constraint');
    const db = wrapConnection(conn);
    await expect(db.transaction((tx) => tx.run('INSERT', []))).rejects.toThrow('constraint');
    expect(conn.calls).toEqual(['begin', 'run:INSERT:[]:false', 'rollback']);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn);
    await expect(db.transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(conn.calls).toEqual(['begin', 'rollback']);
    expect(conn.calls).not.toContain('commit');
  });

  it('maps run results and decodes BLOB columns to Uint8Array', async () => {
    const conn = new FakeConn();
    conn.queryRows = [{ id: 1, data: [0, 1, 255], tags: 'x' }];
    const db = wrapConnection(conn);
    expect(await db.run('INSERT', [])).toEqual({ changes: 1, lastId: 7 });
    const rows = await db.query<{ data: Uint8Array }>('SELECT');
    expect(rows[0]?.data).toEqual(Uint8Array.from([0, 1, 255]));
  });

  it('serialises a plain query behind an open transaction', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn);
    const order: string[] = [];
    const t = db.transaction(async (tx) => {
      await tx.run('IN-TX', []);
      order.push('tx-body-done');
    });
    const q = db.query('OUTSIDE').then(() => order.push('outside'));
    await Promise.all([t, q]);
    expect(order).toEqual(['tx-body-done', 'outside']);
    expect(conn.calls.indexOf('commit')).toBeLessThan(
      conn.calls.findIndex((c) => c.startsWith('query:OUTSIDE')),
    );
  });
});

describe('BLOB parameter encoding', () => {
  it('encodes Uint8Array as the Buffer JSON shape', () => {
    expect(encodeParams([Uint8Array.from([1, 2, 3])])).toEqual([{ type: 'Buffer', data: [1, 2, 3] }]);
  });

  it('leaves other values alone and maps undefined/boolean', () => {
    expect(encodeParams(['a', 5, null, undefined, true, false])).toEqual(['a', 5, null, null, 1, 0]);
  });

  it('decodes only all-byte arrays and keeps other values', () => {
    expect(decodeRow({ a: [1, 2], b: 'text', c: [300], d: null })).toEqual({
      a: Uint8Array.from([1, 2]),
      b: 'text',
      c: [300],
      d: null,
    });
  });
});
