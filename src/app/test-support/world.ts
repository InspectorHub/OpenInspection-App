import { webcrypto } from 'node:crypto';
import { createFakeServer, type FakeServer, type FakeServerOptions } from '../../auth/test-support/fake-server';
import { createMemorySecureStore, type MemorySecureStore } from '../../auth/test-support/memory-secure-store';
import { AuthError } from '../../auth/errors';
import type { FetchLike } from '../../auth/http';
import type { AuthSession } from '../../auth/auth-session';
import { createManualClock, type ManualClock } from '../../platform/clock';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import { composeWith, type AppServices, type ClientPlatform } from '../compose';
import { createMemoryFiles, type MemoryFiles } from './memory-files';
import { connectToServer } from '../connect';

/**
 * jsdom runs tests in a second JavaScript realm, so Node's crypto hands back ArrayBuffers that fail
 * an instanceof check inside oauth4webapi. The device's WebView has one realm; this shim gives the
 * tests the same behaviour: Node's real SHA-256 and random bytes, results copied into this realm.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => webcrypto.getRandomValues(array as never) as T,
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        digest: async (algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> => {
          const out = new Uint8Array(await webcrypto.subtle.digest(algorithm, data));
          const copy = new Uint8Array(out.length);
          copy.set(out);
          return copy.buffer;
        },
      },
    },
  });
}

export interface World {
  services: AppServices;
  server: FakeServer;
  db: Db;
  files: MemoryFiles;
  store: MemorySecureStore;
  clock: ManualClock;
  /** Every URL handed to `fetch`, in order, whatever answered it. */
  fetched: string[];
}

export interface WorldOptions {
  server?: FakeServerOptions;
  /** Replaces the fake server's own sign-in page, for tests that hold a login open. */
  authSession?: (server: FakeServer) => AuthSession;
  /** Replaces the network entirely (a device with no connection). */
  fetch?: FetchLike;
  appVersion?: string;
  /** The client platform the services report. Defaults to Android. */
  platform?: ClientPlatform;
  /** The manual clock's first instant. Defaults to a small number; set a real epoch time where file names carry the time. */
  startMs?: number;
}

/** The real wiring over in-memory fakes: sql.js for the database, a map for the secure store. */
export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const server = createFakeServer(options.server);
  const db = await createSqlJsDb();
  await migrate(db, 0);
  const store = createMemorySecureStore();
  const files = createMemoryFiles();
  const clock = createManualClock(options.startMs ?? 9_000_000);
  const fetched: string[] = [];
  const base: FetchLike = options.fetch ?? server.fetch;
  const services = composeWith({
    db,
    files,
    store,
    fetch: (input, init) => {
      fetched.push(input);
      return base(input, init);
    },
    authSession: options.authSession ? options.authSession(server) : server.authSession,
    clock,
    platform: options.platform ?? 'android',
    appVersion: options.appVersion ?? '1.0.0',
  });
  return { services, server, db, files, store, clock, fetched };
}

export interface HeldAuthSession extends AuthSession {
  /** Number of sign-in pages opened so far. */
  opened: number;
  /** The person finishes signing in on the page. */
  approve(): Promise<void>;
  /** The browser reports that the tab was dismissed. */
  closeBrowser(): void;
}

/** A sign-in page that stays open until the test approves it or `cancel()` ends it. */
export function createHeldAuthSession(server: FakeServer): HeldAuthSession {
  let pendingUrl: string | null = null;
  let resolve: ((callback: string) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  const closedListeners = new Set<() => void>();
  const held: HeldAuthSession = {
    opened: 0,
    start: (url) => {
      held.opened += 1;
      pendingUrl = url;
      return new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    cancel: () => {
      reject?.(new AuthError('sign_in_cancelled'));
    },
    onBrowserClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    closeBrowser: () => {
      for (const listener of closedListeners) listener();
    },
    approve: async () => {
      if (pendingUrl === null || resolve === null) throw new Error('no sign-in page is open');
      resolve(await server.authorize(pendingUrl));
    },
  };
  return held;
}

export async function rowCounts(db: Db): Promise<Record<string, number>> {
  const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
    counts[name] = rows[0]?.n ?? -1;
  }
  return counts;
}

/** One row in every data table a sign-out must leave alone. */
export async function seedLocalData(db: Db): Promise<void> {
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['inspection-1', new Uint8Array([1, 2, 3])]);
  await db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at) VALUES (?, ?, ?, ?, ?)', ['t%3Au', 'k', 'e', '{}', 1]);
  await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['m1', 'i1', 'photo', '/p', 'image/jpeg', '{}', 'pending', 1]);
  await db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['o1', 1, 'save', '{}', 'pending', 1]);
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at) VALUES (?, ?)', ['i1', 1]);
}

/** What a restart looks like: the same database and secure store, new services, and a network that is down. */
export function restartOffline(world: World): { services: AppServices; calls: string[] } {
  const calls: string[] = [];
  const services = composeWith({
    db: world.db,
    files: world.files,
    store: world.store,
    fetch: (input) => {
      calls.push(input);
      return Promise.reject(new TypeError('network down'));
    },
    authSession: world.server.authSession,
    clock: world.clock,
    platform: 'android',
    appVersion: '1.0.0',
  });
  return { services, calls };
}

/** A world where the app has connected to the fake server and signed in once. */
export async function createSignedInWorld(options: WorldOptions = {}): Promise<World> {
  const world = await createWorld(options);
  await connectToServer(world.services, world.server.origin);
  await world.services.flow.signIn(world.server.origin);
  return world;
}
