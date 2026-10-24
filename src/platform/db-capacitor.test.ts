import { describe, expect, it, vi } from 'vitest';
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
  failRollbackWith: Error | null = null;
  /** What the plugin reports after a failed rollback. */
  transactionStillOpen = true;
  failProbeWith: Error | null = null;
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
    if (this.failRollbackWith) return Promise.reject(this.failRollbackWith);
    return Promise.resolve<DbChanges>({});
  }
  isTransactionActive() {
    this.calls.push('isTransactionActive');
    if (this.failProbeWith) return Promise.reject(this.failProbeWith);
    return Promise.resolve({ result: this.transactionStillOpen });
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
  platform: 'android' as const,
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
    const db = wrapConnection(conn, 'android');
    await db.transaction(async (tx) => {
      await tx.run('INSERT 1', [1]);
      await tx.execute('DDL');
    });
    expect(conn.calls).toEqual(['begin', 'run:INSERT 1:[1]:false', 'execute:DDL:false', 'commit']);
  });

  it('uses the plugin default transaction handling outside a manual transaction', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
    await db.run('INSERT 1', [1]);
    expect(conn.calls).toEqual(['run:INSERT 1:[1]:undefined']);
  });

  it('rolls back explicitly and rethrows when a statement fails', async () => {
    const conn = new FakeConn();
    conn.failRunWith = new Error('constraint');
    const db = wrapConnection(conn, 'android');
    await expect(db.transaction((tx) => tx.run('INSERT', []))).rejects.toThrow('constraint');
    expect(conn.calls).toEqual(['begin', 'run:INSERT:[]:false', 'rollback']);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
    await expect(db.transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(conn.calls).toEqual(['begin', 'rollback']);
    expect(conn.calls).not.toContain('commit');
  });

  it('maps run results and decodes BLOB columns to Uint8Array', async () => {
    const conn = new FakeConn();
    conn.queryRows = [{ id: 1, data: [0, 1, 255], tags: 'x' }];
    const db = wrapConnection(conn, 'android');
    expect(await db.run('INSERT', [])).toEqual({ changes: 1, lastId: 7 });
    const rows = await db.query<{ data: Uint8Array }>('SELECT');
    expect(rows[0]?.data).toEqual(Uint8Array.from([0, 1, 255]));
  });

  it('serialises a plain query behind an open transaction', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
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
  it('android: encodes Uint8Array as the Buffer JSON shape', () => {
    expect(encodeParams([Uint8Array.from([1, 2, 3])], 'android')).toEqual([{ type: 'Buffer', data: [1, 2, 3] }]);
  });

  it('ios: encodes Uint8Array as an index-keyed dictionary of integers', () => {
    expect(encodeParams([Uint8Array.from([9, 0, 255])], 'ios')).toEqual([{ '0': 9, '1': 0, '2': 255 }]);
    expect(encodeParams([new Uint8Array(0)], 'ios')).toEqual([{}]);
  });

  it('web: refuses BLOB parameters deterministically, but still binds plain values', () => {
    expect(() => encodeParams([Uint8Array.from([1])], 'web')).toThrow(/BLOB.*web/);
    expect(encodeParams(['a', 1], 'web')).toEqual(['a', 1]);
  });

  it('leaves other values alone and maps undefined/boolean', () => {
    expect(encodeParams(['a', 5, null, undefined, true, false], 'android')).toEqual(['a', 5, null, null, 1, 0]);
  });

  it('wrapConnection applies the platform to run parameters', async () => {
    const conn = new FakeConn();
    await wrapConnection(conn, 'ios').run('INSERT', [Uint8Array.from([5, 6])]);
    expect(conn.calls).toEqual(['run:INSERT:[{"0":5,"1":6}]:undefined']);
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

describe('transaction safety (capacitor adapter)', () => {
  it('queues an unrelated outer call behind an open transaction and runs it after commit', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const txn = db.transaction(async (tx) => {
      await tx.query('IN-TX');
      await gate;
    });
    await Promise.resolve();
    const other = db.query('UNRELATED');
    release();
    await txn;
    await other;
    expect(conn.calls).toEqual(['begin', 'query:IN-TX:undefined', 'commit', 'query:UNRELATED:undefined']);
  });

  it('turns a re-entrant outer call into a timeout error and never runs it', async () => {
    vi.useFakeTimers();
    try {
      const conn = new FakeConn();
      const db = wrapConnection(conn, 'android', { deadlockTimeoutMs: 500 });
      const txn = db.transaction(async () => {
        await db.query('INNER');
      });
      const caught = expect(txn).rejects.toThrow(/waited more than 500 ms behind an open transaction/);
      await vi.advanceTimersByTimeAsync(500);
      await caught;
      await vi.advanceTimersByTimeAsync(5000);
      expect(conn.calls).toEqual(['begin', 'rollback']);
      await db.run('AFTER', []);
      expect(conn.calls).toContain('run:AFTER:[]:undefined');
      expect(conn.calls).not.toContain('query:INNER:undefined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('positive control: the tx handle works inside the same transaction', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
    await db.transaction(async (tx) => {
      await tx.query('VIA-TX');
    });
    expect(conn.calls).toEqual(['begin', 'query:VIA-TX:undefined', 'commit']);
  });

  it('never commits when a nested transaction failed and the outer swallowed it', async () => {
    const conn = new FakeConn();
    const db = wrapConnection(conn, 'android');
    await expect(
      db.transaction(async (tx) => {
        await tx.run('OUTER', []);
        await tx
          .transaction(async (inner) => {
            await inner.run('INNER', []);
            throw new Error('inner failed');
          })
          .catch(() => undefined);
      }),
    ).rejects.toThrow(/nested transaction failed/i);
    expect(conn.calls).not.toContain('commit');
    expect(conn.calls).toContain('rollback');
  });

  it('a failed rollback rethrows the original error and poisons the connection', async () => {
    const conn = new FakeConn();
    conn.failRollbackWith = new Error('rollback boom');
    const db = wrapConnection(conn, 'android');
    await expect(db.transaction(() => Promise.reject(new Error('original')))).rejects.toThrow('original');
    const before = conn.calls.length;
    await expect(db.run('NEXT', [])).rejects.toThrow(/unusable|poisoned/i);
    await expect(db.transaction(async () => undefined)).rejects.toThrow(/unusable|poisoned/i);
    expect(conn.calls.length).toBe(before);
  });

  it('poisons when the plugin cannot say whether a transaction is still open', async () => {
    const conn = new FakeConn();
    conn.failRollbackWith = new Error('rollback boom');
    conn.failProbeWith = new Error('probe boom');
    const db = wrapConnection(conn, 'android');
    await expect(db.transaction(() => Promise.reject(new Error('original')))).rejects.toThrow('original');
    await expect(db.query('NEXT')).rejects.toThrow(/unusable|poisoned/i);
  });

  it('does not poison when the failed rollback only means the plugin already ended the transaction', async () => {
    const conn = new FakeConn();
    conn.failRollbackWith = new Error('no transaction');
    conn.transactionStillOpen = false;
    const db = wrapConnection(conn, 'android');
    await expect(db.transaction(() => Promise.reject(new Error('original')))).rejects.toThrow('original');
    conn.failRollbackWith = null;
    await expect(db.run('NEXT', [])).resolves.toEqual({ changes: 1, lastId: 7 });
  });
});
