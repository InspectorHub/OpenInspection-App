import { describe, expect, it } from 'vitest';
import type { SessionCheck } from '../auth/tokens';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createManualClock } from '../platform/clock';
import { createNativeUploader } from './native-uploader';
import { createFakePlugin, createMediaWorld, INSPECTION, ORIGIN, photoRecord } from './test-support/fakes';
import { neverBlocked } from '../test-support/never-blocked';

const ID = 'photo-1';
const SESSION_OK: SessionCheck = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } };

async function setup() {
  const world = await createMediaWorld();
  const plugin = createFakePlugin({ engine: world.engine, files: world.files });
  const uploader = createNativeUploader({
    isBlocked: neverBlocked,
    store: world.store,
    http: world.engine.http,
    tokens: { getAccessToken: () => Promise.resolve('access-token-secret'), checkSession: () => Promise.resolve(SESSION_OK) },
    plugin,
    origin: ORIGIN,
    isLocked: () => false,
    clientHeaders: {},
    timers: createManualTimers(),
    clock: createManualClock(5_000_000),
    random: () => 1,
  });
  return { world, plugin, uploader };
}

const ref = { pendingId: ID, inspectionId: INSPECTION };

describe('native uploader: dispose() is terminal', () => {
  it('attach() after dispose registers no listener', async () => {
    const s = await setup();
    await s.uploader.attach();
    expect(s.plugin.listenerCount()).toBe(1);
    await s.uploader.dispose();
    expect(s.plugin.listenerCount()).toBe(0);
    await expect(s.uploader.attach()).resolves.toBeUndefined();
    expect(s.plugin.listenerCount()).toBe(0);
  });

  it('an upload asked for after dispose is refused with a fixed code: nothing is requested, nothing is started, the row is untouched', async () => {
    const s = await setup();
    await s.world.store.put(photoRecord(ID));
    await s.uploader.dispose();
    const outcome = await s.uploader.uploadDetailed(ref);
    expect(outcome).toMatchObject({ ok: false, code: 'DISPOSED', retryable: true, halt: true });
    expect(s.world.engine.http.calls).toHaveLength(0);
    expect(s.plugin.starts).toHaveLength(0);
    expect((await s.world.store.getRow(ID))?.state).toBe('pending');
  });

  it('dispose() twice is harmless', async () => {
    const s = await setup();
    await s.uploader.attach();
    await s.uploader.dispose();
    await expect(s.uploader.dispose()).resolves.toBeUndefined();
  });

  it('an upload the plugin is running when dispose() is called ends as halted, is cancelled in the plugin, and its row is put back', async () => {
    const s = await setup();
    s.plugin.defaultBehavior = { kind: 'hang' };
    await s.world.store.put(photoRecord(ID));
    const outcome = s.uploader.uploadDetailed(ref);
    await s.plugin.whenStarted(1);
    expect((await s.world.store.getRow(ID))?.state).toBe('uploading');
    await s.uploader.dispose();
    await expect(outcome).resolves.toMatchObject({ ok: false, code: 'DISPOSED', halt: true });
    expect((await s.world.store.getRow(ID))?.state).toBe('pending');
    expect(s.plugin.removed).toHaveLength(1);
  });
});
