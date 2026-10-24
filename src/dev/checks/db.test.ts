import { describe, expect, it } from 'vitest';
import type { Db } from '../../platform/db';
import { createDiagRig, rowsFor } from '../test-support';
import { dbBlob } from './db-blob';
import { dbTx } from './db-tx';
import type { AppServices } from '../../app/compose';

/** A Db that returns every binary value one byte short: the positive control for the comparison. */
function truncating(db: Db): Db {
  return {
    ...db,
    query: async <T,>(sql: string, params?: unknown[]) => {
      const rows = await db.query<Record<string, unknown>>(sql, params);
      return rows.map((row) => (row.data instanceof Uint8Array && row.data.length > 0 ? { ...row, data: row.data.slice(0, -1) } : row)) as T[];
    },
  };
}

/** A Db whose transaction just runs the callback: nothing is ever rolled back. */
function noRollback(db: Db): Db {
  const handle: Db = { ...db, transaction: (fn) => fn(handle) };
  return handle;
}

describe('db-blob', () => {
  it('passes on a faithful database, names the platform, and leaves no rows behind', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const result = await dbBlob.run(rig.ctx);
    expect(result).toMatchObject({ id: 'db-blob', ok: true, status: 'pass' });
    expect(result.detail).toContain('blobs=3');
    expect(result.detail).toContain('bytes=1048832');
    expect(result.detail).toContain('platform=android');
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-blob')).toBe(0);
  });

  it('control: fails when the adapter returns a damaged value, still cleans up, and says where', async () => {
    const rig = await createDiagRig({ signedIn: false, wrap: (s): AppServices => ({ ...s, db: truncating(s.db) }) });
    const result = await dbBlob.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/case=all256 mismatch_at=\d+ expected_len=256 got_len=255/);
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-blob')).toBe(0);
  });

  it('can be run twice in a row', async () => {
    const rig = await createDiagRig({ signedIn: false });
    expect((await dbBlob.run(rig.ctx)).ok).toBe(true);
    expect((await dbBlob.run(rig.ctx)).ok).toBe(true);
  });
});

describe('db-tx', () => {
  it('passes on the real transaction semantics and removes its rows and its device_state key', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const result = await dbTx.run(rig.ctx);
    expect(result).toMatchObject({ id: 'db-tx', ok: true });
    expect(result.detail).toContain('rollback=ok nested=ok queue_order=ok max_upsert=ok');
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-tx')).toBe(0);
    expect(await rowsFor(rig.services, 'device_state', 'key', 'diag_max')).toBe(0);
  });

  it('control: fails when a throw does not roll back', async () => {
    const rig = await createDiagRig({ signedIn: false, wrap: (s): AppServices => ({ ...s, db: noRollback(s.db) }) });
    const result = await dbTx.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^rollback threw=true rows_left=1/);
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-tx')).toBe(0);
  });

  it('can be run twice in a row', async () => {
    const rig = await createDiagRig({ signedIn: false });
    expect((await dbTx.run(rig.ctx)).ok).toBe(true);
    expect((await dbTx.run(rig.ctx)).ok).toBe(true);
  });
});
