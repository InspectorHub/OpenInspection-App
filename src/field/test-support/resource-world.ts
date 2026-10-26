import { accountKey } from '../../offline/outbox';
import { GLOBAL_PACKAGE_ID } from '../../offline/resource-cache';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import type { ApiOutcome } from '../api-client';
import type { ResourceDeps } from '../resources-shared';
import { scriptedApi, type ScriptedApi } from './scripted-api';
import { ALICE } from './seed-package';

export interface ResourceWorld {
  db: Db;
  api: ScriptedApi;
  deps: ResourceDeps;
  state: { online: boolean; blocked: Set<string> };
  /** Inspections `afterWrite` was asked about. */
  refreshed: string[];
}

export async function resourceWorld(options: { online?: boolean; answers?: ApiOutcome[] } = {}): Promise<ResourceWorld> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const api = scriptedApi(...(options.answers ?? []));
  const state = { online: options.online ?? true, blocked: new Set<string>() };
  const refreshed: string[] = [];
  const deps: ResourceDeps = {
    api,
    db,
    account: ALICE,
    isOnline: () => state.online,
    isBlocked: (id) => Promise.resolve(state.blocked.has(id)),
    photoUrl: (id, key) => `local://${id}/${key}`,
    afterWrite: (id) => {
      refreshed.push(id);
      return Promise.resolve(true);
    },
  };
  return { db, api, deps, state, refreshed };
}

/** Stores one cached read of the signed-in account, as the work package does. */
export async function cacheRow(db: Db, path: string, data: unknown, packageId: string = GLOBAL_PACKAGE_ID): Promise<void> {
  await db.run('INSERT OR REPLACE INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, 1, ?)', [
    accountKey(ALICE),
    path,
    JSON.stringify({ success: true, data }),
    packageId,
  ]);
}
