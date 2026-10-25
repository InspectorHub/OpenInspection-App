import { vi } from 'vitest';
import type { SessionCheck } from '../../auth/tokens';
import type { Db } from '../../platform/db';
import { saveIdentity } from '../../auth/server-config';
import type { CollabSocket, SocketFactory, SocketHandlers } from '../../collab/connector';
import { createFakePlugin, type FakePlugin } from '../../media/test-support/fakes';
import { recordVerified } from '../../offline/lock-state';
import type { StackDiagnostic } from '../offline-stack';
import { createOfflineStack, type OfflineStack, type OfflineStackDeps } from '../offline-stack';
import { createUnlockEmitter, type UnlockEmitter } from '../lock-events';
import { createPackageServer, jsonReply, NOW, type PackageServer } from '../../offline/test-support/package-world';
import { ALICE, GOOD_TOKEN, ORIGIN, SESSION_OK, createReplayWorld, type ReplayWorld } from '../../offline/test-support/replay-world';
import { createMemoryFiles, type MemoryFiles } from './memory-files';

export interface FakeSocketFactory {
  factory: SocketFactory;
  opened: string[];
  handlers: SocketHandlers[];
}

export function createSocketFactory(): FakeSocketFactory {
  const opened: string[] = [];
  const handlers: SocketHandlers[] = [];
  const factory: SocketFactory = (url, h) => {
    opened.push(url);
    handlers.push(h);
    const socket: CollabSocket = { isOpen: () => false, send: () => undefined, close: () => undefined };
    return socket;
  };
  return { factory, opened, handlers };
}

export interface VerifiedHook {
  on(listener: () => void): () => void;
  fire(): void;
  listeners(): number;
}

export function createVerifiedHook(): VerifiedHook {
  const set = new Set<() => void>();
  return {
    on: (listener) => {
      set.add(listener);
      return () => set.delete(listener);
    },
    fire: () => {
      for (const listener of [...set]) listener();
    },
    listeners: () => set.size,
  };
}

/** The database with the statements that match `failQuery` / `failRun` rejecting; everything else is delegated. */
export function dbThatFails(db: Db, fail: { query?: RegExp; run?: RegExp }): Db {
  return {
    ...db,
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> => (fail.query?.test(sql) ? Promise.reject(new Error('injected read failure')) : db.query<T>(sql, params)),
    run: (sql, params) => (fail.run?.test(sql) ? Promise.reject(new Error('injected write failure')) : db.run(sql, params)),
  };
}

export interface StackWorld {
  replay: ReplayWorld;
  pkg: PackageServer;
  files: MemoryFiles;
  plugin: FakePlugin;
  sockets: FakeSocketFactory;
  unlocks: UnlockEmitter;
  verified: VerifiedHook;
  diagnostics: StackDiagnostic[];
  /** The lock the stack sees unless a test passes its own `isLocked`. */
  lock: { locked: boolean };
  tokensCheck: () => Promise<SessionCheck>;
  make(overrides?: Partial<OfflineStackDeps>): OfflineStack;
  /** Every listener and timer the fakes still hold. All zero once a stack has stopped. */
  residue(): { network: number; appState: number; unlock: number; verified: number; timers: number; plugin: number };
}

/** The real stack over in-memory fakes: sql.js, a scripted server, manual timers, a fake uploader plugin and socket. */
export async function createStackWorld(): Promise<StackWorld> {
  const replay = await createReplayWorld();
  replay.clock.set(NOW);
  await saveIdentity(replay.db, { userId: ALICE.userId, tenantId: ALICE.tenantId, role: 'inspector' });
  await recordVerified(replay.db, NOW, 30);
  const pkg = createPackageServer();
  pkg.overrides.set('/api/inspections', (req) => (req.method === 'POST' ? jsonReply(201, { success: true, data: { inspection: { id: (JSON.parse(req.body ?? '{}') as { id: string }).id } } }) : undefined));
  pkg.overrides.set('/api/client/session', () => jsonReply(200, { success: true, data: { userId: ALICE.userId, tenantId: ALICE.tenantId, role: 'inspector', offlineMaxDays: 7 } }));
  pkg.overrides.set('/api/client/inspections/visible', (req) => jsonReply(200, { success: true, data: { visible: (JSON.parse(req.body ?? '{}') as { ids: string[] }).ids } }));
  const files = createMemoryFiles();
  const plugin = createFakePlugin({ files });
  const sockets = createSocketFactory();
  const unlocks = createUnlockEmitter();
  const verified = createVerifiedHook();
  const diagnostics: StackDiagnostic[] = [];
  const lock = { locked: false };
  const tokensCheck = vi.fn((): Promise<SessionCheck> => Promise.resolve(SESSION_OK));
  let leaseTokens = 0;
  return {
    replay,
    pkg,
    files,
    plugin,
    sockets,
    unlocks,
    verified,
    diagnostics,
    lock,
    tokensCheck,
    make: (overrides = {}) =>
      createOfflineStack({
        db: replay.db,
        files,
        http: pkg.http,
        tokens: { getAccessToken: () => Promise.resolve(GOOD_TOKEN), checkSession: tokensCheck },
        origin: ORIGIN,
        identity: { userId: ALICE.userId, tenantId: ALICE.tenantId, role: 'inspector' },
        clientHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' },
        clock: replay.clock,
        network: replay.network,
        appState: replay.appState,
        uploaderPlugin: plugin,
        openSocket: sockets.factory,
        timers: replay.timers,
        onUnlocked: unlocks.onUnlocked,
        onTokenVerified: verified.on,
        isLocked: () => lock.locked,
        onDiagnostic: (code) => diagnostics.push(code),
        tuning: { random: () => 0.5, newToken: () => `stack-holder-${String((leaseTokens += 1))}` },
        ...overrides,
      }),
    residue: () => ({
      network: replay.network.listeners(),
      appState: replay.appState.listeners(),
      unlock: unlocks.listeners(),
      verified: verified.listeners(),
      timers: replay.timers.pending(),
      plugin: plugin.listenerCount(),
    }),
  };
}
