import * as Y from 'yjs';
import type { CollabConnector, NotifyVariant, ResultsDocHandle, FieldDataSource } from '@inspectorhub/field-ui';
import { createMemoryFiles, type MemoryFiles } from '../../app/test-support/memory-files';
import { createManualTimers } from '../../collab/test-support/manual-timers';
import { createMediaStore, type MediaStore } from '../../media/store';
import { INSPECTION } from '../../media/test-support/fakes';
import { createManualClock } from '../../platform/clock';
import type { Db } from '../../platform/db';
import { createSqlJsDb } from '../../platform/db-sqljs';
import { migrate } from '../../platform/schema';
import { createEditorRegistry } from '../editor-registry';
import type { LocalDataSourceDeps, LocalStack } from '../local-data-source';
import { createLocalDataSource } from '../local-data-source';
import { scriptedApi, type ScriptedApi } from './scripted-api';
import { ALICE, seedPackage } from './seed-package';

export interface World {
  db: Db;
  files: MemoryFiles;
  store: MediaStore;
  api: ScriptedApi;
  stack: LocalStack;
  online: { value: boolean };
  notes: [string, NotifyVariant][];
  exits: number;
  reloads: number;
  triggers: string[];
  opened: string[];
  nativeCalls: string[];
  handle: ResultsDocHandle;
  /** What the open document reports as `synced()`. */
  sync: { value: boolean };
  source: FieldDataSource;
  deps: LocalDataSourceDeps;
  registry: ReturnType<typeof createEditorRegistry>;
}

export async function world(over: Partial<LocalDataSourceDeps> = {}): Promise<World> {
  const db = await createSqlJsDb();
  await migrate(db, 0);
  await seedPackage(db, INSPECTION);
  const files = createMemoryFiles();
  const store = createMediaStore({ db, files, isBlocked: () => Promise.resolve(false) });
  const clock = createManualClock(10_000);
  const api = scriptedApi();
  const online = { value: true };
  const triggers: string[] = [];
  const nativeCalls: string[] = [];
  const sync = { value: true };
  const doc = new Y.Doc();
  const handle: ResultsDocHandle = { doc, persistenceSynced: Promise.resolve(), synced: () => sync.value, destroy: () => undefined };
  const connector: CollabConnector = { connect: () => handle, purge: () => Promise.resolve() };
  const stack: LocalStack = {
    db,
    account: ALICE,
    store,
    uploader: { uploadDetailed: (ref) => (nativeCalls.push(ref.pendingId), Promise.resolve({ ok: true as const, key: `k/${ref.pendingId}`, reused: false })) },
    connector,
    refresher: { refreshInspection: () => Promise.resolve({ kind: 'refreshed' } as never) },
    reconciler: { trigger: (reason) => void triggers.push(reason) },
    enqueue: async (op, input) => {
      const { enqueue } = await import('../../offline/outbox');
      return enqueue({ db, clock }, op, input, { account: ALICE });
    },
    idle: () => Promise.resolve(),
  };
  const w = { notes: [] as [string, NotifyVariant][], exits: 0, reloads: 0, opened: [] as string[] };
  const registry = createEditorRegistry();
  const deps: LocalDataSourceDeps = {
    stack,
    api,
    files,
    network: { isOnline: () => online.value, onOnlineChange: () => () => undefined },
    registry,
    session: {
      tenantSlug: 'acme', videoProvider: 'r2', streamCustomerSubdomain: null, collabEditing: true, userId: null, role: 'inspector', locale: 'en-US', timeZone: 'UTC',
      dateFormat: 'us', timeFormat: '12h', tenantDateFormat: 'us', tenantTimeFormat: '12h',
    },
    origin: 'https://app.example.com',
    platform: 'android',
    signedAtMs: () => 5000,
    clock,
    timers: createManualTimers(),
    notify: (message, variant) => w.notes.push([message, variant]),
    openExternal: (url) => (w.opened.push(url), Promise.resolve()),
    onExit: () => void (w.exits += 1),
    onReload: () => void (w.reloads += 1),
    ...over,
  };
  const source = createLocalDataSource(deps);
  return {
    db, files, store, api, stack, online, triggers, nativeCalls, handle, sync, source, deps, registry,
    get notes() { return w.notes; },
    get exits() { return w.exits; },
    get reloads() { return w.reloads; },
    get opened() { return w.opened; },
  };
}

