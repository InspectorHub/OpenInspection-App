import { describe, expect, it } from 'vitest';
import { createSqlJsDb } from '../platform/db-sqljs';
import type { Db } from '../platform/db';
import { migrate } from '../platform/schema';
import type { Account } from './outbox';
import { createOtherAccountGuard } from './package-owner';

const ME: Account = { tenantId: 't1', userId: 'u1' };

async function database(): Promise<Db> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const add = (id: string, tenant: string | null, user: string | null) =>
    db.run('INSERT INTO work_package (inspection_id, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, 0, 1, ?, ?)', [id, tenant, user]);
  await add('mine', 't1', 'u1');
  await add('other-user', 't1', 'u2');
  await add('other-tenant', 't2', 'u1');
  await add('no-owner', null, null);
  return db;
}

describe('createOtherAccountGuard', () => {
  it('is true only for a package that names a different owner (control: the account\'s own package is not)', async () => {
    const guard = createOtherAccountGuard(await database(), () => Promise.resolve(ME));
    await expect(guard('mine')).resolves.toBe(false);
    await expect(guard('other-user')).resolves.toBe(true);
    await expect(guard('other-tenant')).resolves.toBe(true);
  });

  it('an owner-less package and an inspection with no package are not another account\'s', async () => {
    const guard = createOtherAccountGuard(await database(), () => Promise.resolve(ME));
    await expect(guard('no-owner')).resolves.toBe(false);
    await expect(guard('never-seen')).resolves.toBe(false);
  });

  it('when the account cannot be read nothing is claimed as this account\'s', async () => {
    const guard = createOtherAccountGuard(await database(), () => Promise.resolve(null));
    await expect(guard('mine')).resolves.toBe(true);
  });

  it('rejects when the package cannot be read, so the caller decides', async () => {
    const db = await database();
    const broken: Db = { ...db, query: () => Promise.reject(new Error('db')) };
    await expect(createOtherAccountGuard(broken, () => Promise.resolve(ME))('mine')).rejects.toThrow('db');
  });
});
