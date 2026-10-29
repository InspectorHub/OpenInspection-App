import { describe, expect, it } from 'vitest';
import { saveIdentity, writeDeviceState } from '../auth/server-config';
import { takeRejected } from '../field/item-tags-notice';
import { addTag } from '../field/item-tags-store';
import { evaluateLock } from '../offline/lock';
import { loadLockState } from '../offline/lock-state';
import { accountKey } from '../offline/outbox';
import { ALICE, BOB } from '../offline/test-support/replay-world';
import { jsonReply, NOW } from '../offline/test-support/package-world';
import { createStore } from './stack-store';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

/**
 * The tags a person put on items while no editor was open are sent by the stack itself, at the replayer's trigger points and
 * under its gates. Every negative here is paired with a positive control in the same test: the same tag IS sent once the
 * thing that blocked it is gone, so a test that only "sees nothing" cannot pass on a flush that never runs.
 */

const tagPath = (inspection: string, item: string): string => `/api/inspections/${inspection}/items/${item}/tags`;

async function keep(w: StackWorld, inspection: string, item: string, tag: string): Promise<void> {
  await addTag(w.replay.db, accountKey(ALICE), inspection, item, { id: tag, name: tag }, NOW);
}

/** The server takes the add. */
function accept(w: StackWorld, inspection: string, item: string): void {
  w.pkg.overrides.set(tagPath(inspection, item), () => jsonReply(200, { success: true }));
}

const tagRequests = (w: StackWorld) => w.pkg.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/tags'));

async function stateOf(w: StackWorld, tag: string): Promise<string | undefined> {
  return (await w.replay.db.query<{ state: string }>('SELECT state FROM item_tags WHERE tag_id = ?', [tag]))[0]?.state;
}

async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

describe('the points that send unsent tags', () => {
  it('start: a tag waiting when the stack starts is sent after the first replay', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    const stack = w.make();
    await run(stack);
    expect(tagRequests(w)).toHaveLength(1);
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('the network coming back: nothing is sent offline, and the tag goes when the connection returns', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    w.replay.network.set(false);
    const stack = w.make();
    await run(stack);
    await keep(w, 'insp-1', 'i1', 'tag-a');
    // Other triggers fire while the device is offline: they must not send either.
    w.replay.appState.emit(true);
    w.verified.fire();
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(1);
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('the app coming to the front sends a tag the last attempt could not', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(tagPath('insp-1', 'i1'), () => jsonReply(503, { success: false }));
    await keep(w, 'insp-1', 'i1', 'tag-a');
    const stack = w.make();
    await run(stack);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    accept(w, 'insp-1', 'i1');
    w.replay.appState.emit(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('an unlock sends a tag that was kept while the device was locked', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const stack = w.make();
    await run(stack);
    w.lock.locked = true;
    w.unlocks.note({ locked: true, reason: 'expired' });
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);

    w.lock.locked = false;
    w.unlocks.note({ locked: false });
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('a confirmed sign-in sends a tag that the last attempt could not', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(tagPath('insp-1', 'i1'), () => jsonReply(503, { success: false }));
    await keep(w, 'insp-1', 'i1', 'tag-a');
    const stack = w.make();
    await run(stack);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    accept(w, 'insp-1', 'i1');
    w.verified.fire();
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('a server that was too old and no longer is: nothing is sent while it is, the tag goes when it is not', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const state = createStore<{ value: boolean }>({ value: true });
    const stack = w.make({ serverTooOld: { get: () => state.get().value, subscribe: state.subscribe } });
    await keep(w, 'insp-1', 'i1', 'tag-a');
    await run(stack);
    expect(tagRequests(w)).toHaveLength(0);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    state.patch({ value: false });
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });
});

describe('a change the server refuses for good during a background send', () => {
  it('is undone and kept as a count for the next editor open', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(tagPath('insp-1', 'i1'), () => jsonReply(404, { success: false }));
    w.pkg.overrides.set(tagPath('insp-1', 'i2'), () => jsonReply(409, { success: false }));
    accept(w, 'insp-1', 'i3');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    await keep(w, 'insp-1', 'i2', 'tag-b');
    await keep(w, 'insp-1', 'i3', 'tag-c');
    const stack = w.make();
    await run(stack);
    expect(await stateOf(w, 'tag-a')).toBeUndefined();
    expect(await stateOf(w, 'tag-b')).toBeUndefined();
    expect(await stateOf(w, 'tag-c')).toBe('synced');
    expect(await takeRejected(w.replay.db, ALICE)).toBe(2);
    await stack.stop();
  });

  it('nothing is kept when nothing was refused (control)', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    const stack = w.make();
    await run(stack);
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    expect(await takeRejected(w.replay.db, ALICE)).toBe(0);
    await stack.stop();
  });

  it('a count that cannot be stored is reported and does not break the flush or the stack', async () => {
    const w = await createStackWorld();
    w.pkg.overrides.set(tagPath('insp-1', 'i1'), () => jsonReply(404, { success: false }));
    accept(w, 'insp-1', 'i2');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    await keep(w, 'insp-1', 'i2', 'tag-b');
    // The tag rows are settled with plain statements; the count is the only transaction the flush opens.
    w.replay.db.transaction = () => Promise.reject(new Error('disk full'));
    const stack = w.make();
    await run(stack);
    expect(w.diagnostics).toContain('tags_error');
    expect(await stateOf(w, 'tag-b')).toBe('synced');
    expect(stack.isStopped()).toBe(false);
    await stack.stop();
  });
});

describe('the gates', () => {
  it('locked from the start: nothing is sent, and the first unlock sends', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.lock.locked = true;
    w.unlocks.note({ locked: true, reason: 'expired' });
    const stack = w.make();
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);

    w.lock.locked = false;
    w.unlocks.note({ locked: false });
    await stack.settled();
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('a lock that arrives while running: the network returning sends nothing', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const stack = w.make();
    await run(stack);
    w.lock.locked = true;
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(false);
    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    w.lock.locked = false;
    w.replay.network.set(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('revoked: the stored lock state keeps every tag where it is', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const isLocked = async (): Promise<boolean> => evaluateLock(await loadLockState(w.replay.db), w.replay.clock.now()).locked;
    const stack = w.make({ isLocked });
    await run(stack);
    await writeDeviceState(w.replay.db, 'locked_reason', 'revoked');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    await writeDeviceState(w.replay.db, 'locked_reason', '');
    w.replay.network.set(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('the server too old: nothing is sent (see also the resume test above)', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const state = createStore<{ value: boolean }>({ value: false });
    const stack = w.make({ serverTooOld: { get: () => state.get().value, subscribe: state.subscribe } });
    await run(stack);
    state.patch({ value: true });
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);

    // Control: the same tag goes once the server is not too old, with no other change.
    state.patch({ value: false });
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(1);
    await stack.stop();
  });

  it('an inspection that is blocked (quarantined) is skipped; another inspection is sent', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-blocked', 'i1');
    accept(w, 'insp-free', 'i1');
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, quarantine_source) VALUES (?, 1, 0, 1, ?, ?, ?)', ['insp-blocked', ALICE.tenantId, ALICE.userId, 'test']);
    await keep(w, 'insp-blocked', 'i1', 'tag-b');
    await keep(w, 'insp-free', 'i1', 'tag-f');
    const stack = w.make();
    await run(stack);
    expect(await stateOf(w, 'tag-f')).toBe('synced');
    expect(await stateOf(w, 'tag-b')).toBe('add');
    expect(tagRequests(w).map((r) => r.path)).toEqual([tagPath('insp-free', 'i1')]);
    await stack.stop();
  });

  it('signed out (the stored identity is gone or another account): nothing is sent; the stored account sends', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const stack = w.make();
    await run(stack);
    await saveIdentity(w.replay.db, { userId: BOB.userId, tenantId: BOB.tenantId, role: 'inspector' });
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(true);
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(0);

    await saveIdentity(w.replay.db, { userId: ALICE.userId, tenantId: ALICE.tenantId, role: 'inspector' });
    w.replay.network.set(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('a stopped stack sends nothing, whatever wakes it', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    const stack = w.make();
    await run(stack);
    // Control: while running, the network edge sends.
    await keep(w, 'insp-1', 'i1', 'tag-before');
    w.replay.network.set(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-before')).toBe('synced');

    await stack.stop();
    await keep(w, 'insp-1', 'i1', 'tag-after');
    const before = tagRequests(w).length;
    w.replay.network.set(true);
    w.replay.appState.emit(true);
    w.unlocks.note({ locked: false });
    w.verified.fire();
    await stack.idle();
    expect(tagRequests(w).length).toBe(before);
    expect(await stateOf(w, 'tag-after')).toBe('add');
  });

  it('a stop while a flush is running: the row in flight settles, the rest are not sent', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    accept(w, 'insp-1', 'i2');
    await keep(w, 'insp-1', 'i1', 'tag-1');
    await keep(w, 'insp-1', 'i2', 'tag-2');
    const stack = w.make();
    w.pkg.hook = (request) => {
      if (request.path.endsWith('/tags')) void stack.stop();
    };
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(tagRequests(w)).toHaveLength(1);
    const states = [await stateOf(w, 'tag-1'), await stateOf(w, 'tag-2')].sort();
    expect(states).toEqual(['add', 'synced']);
  });

  it('a flush that cannot run is reported and changes nothing else; the next trigger sends', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    let broken = false;
    const stack = w.make({
      isLocked: () => {
        if (broken) throw new Error('lock state unreadable');
        return w.lock.locked;
      },
    });
    await run(stack);
    broken = true;
    await keep(w, 'insp-1', 'i1', 'tag-a');
    w.replay.network.set(true);
    await stack.idle();
    expect(w.diagnostics).toContain('tags_error');
    expect(stack.isStopped()).toBe(false);
    expect(await stateOf(w, 'tag-a')).toBe('add');

    broken = false;
    w.replay.network.set(true);
    await stack.idle();
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    await stack.stop();
  });

  it('a trigger during a run makes one more run, so a tag kept meanwhile is sent, and no row is sent twice', async () => {
    const w = await createStackWorld();
    accept(w, 'insp-1', 'i1');
    accept(w, 'insp-1', 'i2');
    await keep(w, 'insp-1', 'i1', 'tag-a');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.pkg.hook = async (request) => {
      if (request.path.endsWith('/tags')) await gate;
    };
    const stack = w.make();
    stack.start();
    await stack.settled();
    // The first send is held. A second tag is kept and a trigger arrives (several, in fact) while it is.
    await keep(w, 'insp-1', 'i2', 'tag-b');
    for (let i = 0; i < 5; i += 1) {
      w.replay.network.set(true);
      w.replay.appState.emit(true);
    }
    release();
    await stack.idle();
    expect(tagRequests(w).map((r) => r.path).sort()).toEqual([tagPath('insp-1', 'i1'), tagPath('insp-1', 'i2')]);
    expect(await stateOf(w, 'tag-a')).toBe('synced');
    expect(await stateOf(w, 'tag-b')).toBe('synced');
    await stack.stop();
  });
});

describe('the lifecycle', () => {
  it('adds no listener before the start sequence has reached it, and leaves none after stop', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
    await run(stack);
    await stack.stop();
    expect(w.residue()).toEqual({ network: 0, appState: 0, unlock: 0, verified: 0, timers: 0, plugin: 0 });
  });
});
