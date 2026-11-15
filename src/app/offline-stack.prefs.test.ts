import { describe, expect, it } from 'vitest';
import { addTag } from '../field/item-tags-store';
import { accountKey } from '../offline/outbox';
import { ALICE } from '../offline/test-support/replay-world';
import { jsonReply, NOW } from '../offline/test-support/package-world';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

/**
 * The company's editor preferences: a change made on this device without a connection is sent by the stack itself when the
 * connection returns. Every negative is paired with a positive control (the same change IS sent once the link is back), so a
 * test that only "sees nothing" cannot pass on a flush that never runs.
 */

const PREFS = '/api/tenant/inspection-prefs';
const prefsPatches = (w: StackWorld) => w.pkg.requests.filter((r) => r.method === 'PATCH' && r.path === PREFS);

describe('a preference change made offline', () => {
  it('is not sent while offline and is sent once, with only the changed field, when the network returns', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(PREFS, () => jsonReply(200, { cloneDefault: 'rating_notes', autoAdvance: 'off', autoAdvanceDelayMs: 200, pinnedTagIds: [] }));
    w.replay.network.set(false);
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();

    const saved = await stack.prefs.patch({ autoAdvance: 'off' });
    expect(saved.ok).toBe(true);
    expect((await stack.prefs.peek()).pending).toBe(true);
    // Other triggers fire while the device is offline: they must not send either.
    w.replay.appState.emit(true);
    await stack.idle();
    expect(prefsPatches(w)).toHaveLength(0);

    w.replay.network.set(true);
    await stack.idle();
    expect(prefsPatches(w)).toHaveLength(1);
    expect((await stack.prefs.peek()).pending).toBe(false);
    expect((await stack.prefs.peek()).prefs.autoAdvance).toBe('off');
    await stack.stop();
  });

  it('is still sent when a tag send in the same run is answered with a server error', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(PREFS, () => jsonReply(200, { autoAdvance: 'off' }));
    w.pkg.overrides.set('/api/inspections/insp-1/items/i1/tags', () => jsonReply(503, { success: false }));
    await addTag(w.replay.db, accountKey(ALICE), 'insp-1', 'i1', { id: 'tag-a', name: 'tag-a' }, NOW);
    w.replay.network.set(false);
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    await stack.prefs.patch({ autoAdvance: 'off' });

    w.replay.network.set(true);
    await stack.idle();
    expect(w.pkg.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/tags')).length).toBeGreaterThan(0); // the tag send ran and failed
    expect(prefsPatches(w)).toHaveLength(1);
    await stack.stop();
  });
});
