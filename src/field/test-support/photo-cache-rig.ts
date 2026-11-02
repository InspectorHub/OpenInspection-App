import { expect } from 'vitest';
import { createMemoryFiles, type MemoryFiles } from '../../app/test-support/memory-files';
import type { Account } from '../../offline/outbox';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import { createManualTimers, type ManualTimers } from '../../collab/test-support/manual-timers';
import type { Api, ApiCall, ApiOutcome } from '../api-client';
import { createPhotoCache, type PhotoCache, type PhotoCacheLimits } from '../photo-cache';

export const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
export const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
export const INSPECTION = 'insp-1';
export const key = (name: string): string => `tenant-1/inspections/${INSPECTION}/photos/${name}.jpg`;
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50]);

export type Answer = ApiOutcome | ((call: ApiCall) => ApiOutcome);
export const ok = (bytes: Uint8Array, contentType = 'image/jpeg'): ApiOutcome => ({ kind: 'response', status: 200, json: undefined, bytes, contentType });
export const status = (code: number, retryAfterMs: number | null = null): ApiOutcome => ({ kind: 'response', status: code, json: undefined, bytes: new Uint8Array(), contentType: 'text/plain', retryAfterMs });
export const problem = (p: Extract<ApiOutcome, { kind: 'problem' }>['problem']): ApiOutcome => ({ kind: 'problem', problem: p });

export interface Rig {
  cache: PhotoCache;
  calls: ApiCall[];
  files: MemoryFiles;
  db: Db;
  timers: ManualTimers;
  notified: () => number;
  answer(next: Answer): void;
  setOnline(value: boolean): void;
  /** Lets the deferred answers through. */
  release(): void;
  clock: { now: number };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function rig(options: { account?: Account; online?: boolean; ready?: Promise<void>; answerWith?: Answer; deferred?: boolean; onError?: (error: unknown) => void; limits?: Partial<PhotoCacheLimits>; db?: Db; files?: MemoryFiles; localCopy?: Parameters<typeof createPhotoCache>[0]['localCopy'] } = {}): Promise<Rig> {
  const db = options.db ?? (await createSqlJsDb());
  if (options.db === undefined) await migrate(db, 0);
  const files = options.files ?? createMemoryFiles();
  const timers = createManualTimers();
  const calls: ApiCall[] = [];
  let answerWith: Answer = options.answerWith ?? ok(JPEG);
  const release: (() => void)[] = [];
  let online = options.online ?? true;
  const listeners = new Set<(online: boolean) => void>();
  const clock = { now: 1_000_000 };
  let count = 0;
  const api: Pick<Api, 'send'> = {
    send: (call) => {
      calls.push(call);
      const result = typeof answerWith === 'function' ? answerWith(call) : answerWith;
      return options.deferred === true ? new Promise<ApiOutcome>((resolve) => release.push(() => resolve(result))) : Promise.resolve(result);
    },
  };
  const cache = createPhotoCache({
    db,
    files,
    api,
    account: options.account ?? ALICE,
    network: { ready: options.ready ?? Promise.resolve(), isOnline: () => online, onOnlineChange: (cb) => (listeners.add(cb), () => listeners.delete(cb)) },
    clock: { now: () => clock.now },
    timers,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.localCopy === undefined ? {} : { localCopy: options.localCopy }),
  });
  cache.subscribe(() => void (count += 1));
  return {
    cache, calls, files, db, timers, clock, notified: () => count,
    answer: (next) => void (answerWith = next),
    release: () => release.splice(0).forEach((fn) => fn()),
    setOnline: (value) => {
      online = value;
      for (const cb of [...listeners]) cb(value);
    },
  };
}

/** Fires the notification pause. */
export function flush(r: Rig): void {
  while (r.timers.pending() > 0) r.timers.fireNext();
}

export async function fetchOnce(r: Rig, name: string, size: 'thumb' | 'view' | 'original' = 'thumb'): Promise<string | null> {
  expect(r.cache.lookup(INSPECTION, key(name), size)).toBeNull();
  await settle();
  flush(r);
  return r.cache.lookup(INSPECTION, key(name), size);
}
