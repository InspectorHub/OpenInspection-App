import type { Db } from '../../platform/db';
import { createStackWorld, type StackWorld } from '../../app/test-support/stack-world';
import type { OfflineStack } from '../../app/offline-stack';
import { MAX_UPLOAD_ATTEMPTS } from '../../media/native-uploader';
import { accountKey } from '../../offline/outbox';
import { ALICE, BOB } from '../../offline/test-support/replay-world';

export { ALICE, BOB };

/** Noon on a Monday in the machine's own time zone, so the day groups do not depend on where the tests run. */
export const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
export const at = (dayOffset: number, hour = 15): number => new Date(2026, 9, 26 + dayOffset, hour, 0, 0).getTime();

export interface Pkg {
  id: string;
  scheduledAt?: number | null;
  pinned?: number;
  confirmed?: number;
  purging?: number;
  quarantine?: string | null;
  refreshedAt?: number;
  owner?: { tenantId: string; userId: string };
}

export async function seedPkg(db: Db, p: Pkg): Promise<void> {
  const owner = p.owner ?? ALICE;
  await db.run(
    'INSERT INTO work_package (inspection_id, refreshed_at, pinned, scheduled_at, server_confirmed, tenant_id, user_id, purging, quarantine_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [p.id, p.refreshedAt ?? 0, p.pinned ?? 0, p.scheduledAt === undefined ? null : p.scheduledAt, p.confirmed ?? 1, owner.tenantId, owner.userId, p.purging ?? 0, p.quarantine ?? null],
  );
}

/** A cached resource of the package: the inspection row (with its address) and nothing else. */
export async function seedCached(db: Db, id: string, address: string | null, fetchedAt = NOW): Promise<void> {
  const body = JSON.stringify({ success: true, data: { inspection: { id, ...(address === null ? {} : { propertyAddress: address }) } } });
  await db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [accountKey(ALICE), `/api/inspections/${id}`, body, fetchedAt, id]);
}

export async function seedRefreshError(db: Db, id: string, code: string): Promise<void> {
  await db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [accountKey(ALICE), `$refresh_error:${id}`, code, NOW, id]);
}

export interface Queued {
  key: string;
  seq: number;
  inspectionId: string | null;
  state?: 'pending' | 'failed' | 'orphaned';
  op?: string;
  error?: string | null;
  payload?: string;
  owner?: { tenantId: string; userId: string } | null;
}

export async function seedQueued(db: Db, q: Queued): Promise<void> {
  const owner = q.owner === undefined ? ALICE : q.owner;
  await db.run(
    'INSERT INTO outbox (idempotency_key, seq, op, payload, state, last_error, created_at, inspection_id, tenant_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [q.key, q.seq, q.op ?? 'inspection.update', q.payload ?? '{"x":1}', q.state ?? 'pending', q.error ?? null, NOW, q.inspectionId, owner?.tenantId ?? null, owner?.userId ?? null],
  );
}

/** A `failed` row is by default a permanently refused one (at the attempt limit); pass `attempts` for one still being retried. */
export async function seedMedia(db: Db, id: string, inspectionId: string, state: 'pending' | 'uploading' | 'uploaded' | 'failed', options: { attempts?: number; meta?: string } = {}): Promise<void> {
  const attempts = options.attempts ?? (state === 'failed' ? MAX_UPLOAD_ATTEMPTS : 0);
  await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, inspectionId, 'photo', `media/${id}.jpg`, 'image/jpeg', options.meta ?? '{}', state, attempts, NOW]);
}

export async function seedTenantName(db: Db, name: string): Promise<void> {
  await db.run("INSERT INTO device_state (key, value) VALUES ('tenant_name', ?)", [name]);
}

export interface ListWorld {
  world: StackWorld;
  stack: OfflineStack;
  db: Db;
}

/** The real stack over the in-memory fakes, NOT started: nothing talks to a server unless a test asks it to. */
export async function createListWorld(): Promise<ListWorld> {
  const world = await createStackWorld();
  const stack = world.make();
  return { world, stack, db: world.replay.db };
}
