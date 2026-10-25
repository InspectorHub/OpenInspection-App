import { createManualTimers } from '../../collab/test-support/manual-timers';
import { createNativeUploader, type NativeUploader } from '../../media/native-uploader';
import { createFakePlugin, createMediaWorld, ORIGIN, type FakePlugin, type MediaWorld } from '../../media/test-support/fakes';
import { createManualClock } from '../../platform/clock';
import { createStoredBlobReader, createUploaderFactory, type UploaderDeps } from '../uploader';
import { createForegroundUploads } from '../uploader-foreground';
import { scriptedApi, type ScriptedApi } from './scripted-api';

const SESSION_OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as const;

export interface UploaderWorld {
  world: MediaWorld;
  plugin: FakePlugin;
  native: NativeUploader;
  api: ScriptedApi;
  /** Inspections the guard reports as blocked. */
  blocked: Set<string>;
  errors: unknown[];
  deps: UploaderDeps;
  factory: ReturnType<typeof createUploaderFactory>;
  /** `uploadDetailed` calls the composite made on the real uploader, in order. */
  nativeCalls: string[];
}

/** The real photo store, a fake plugin and the real background uploader, with a scripted Bearer client for the foreground calls. */
export async function createUploaderWorld(options: { api?: ScriptedApi } = {}): Promise<UploaderWorld> {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const timers = createManualTimers();
  const native = createNativeUploader({
    isBlocked: () => Promise.resolve(false),
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve('access-token'), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => false,
    clientHeaders: {},
    timers,
    clock: createManualClock(1_000_000),
    random: () => 1,
  });
  const api = options.api ?? scriptedApi();
  const blocked = new Set<string>();
  const errors: unknown[] = [];
  const nativeCalls: string[] = [];
  const counted: Pick<NativeUploader, 'uploadDetailed'> = {
    uploadDetailed: (ref, opts) => {
      nativeCalls.push(ref.pendingId);
      return native.uploadDetailed(ref, opts);
    },
  };
  const deps: UploaderDeps = {
    isBlocked: (id) => Promise.resolve(blocked.has(id)),
    store: world.store,
    native: counted,
    foreground: createForegroundUploads({ api, readStoredBlob: createStoredBlobReader(world.store, world.files) }),
    onError: (error) => errors.push(error),
  };
  return { world, plugin, native, api, blocked, errors, deps, factory: createUploaderFactory(deps), nativeCalls };
}
