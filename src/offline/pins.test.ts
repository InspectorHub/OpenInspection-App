import { beforeEach, describe, expect, it } from 'vitest';
import { setPinned, type PinRefusalReason } from './pins';
import { createReplayWorld, ALICE, BOB, type ReplayWorld } from './test-support/replay-world';
import { seedPkg, type Pkg } from '../ui/test-support/worklist-world';

let world: ReplayWorld;

beforeEach(async () => {
  world = await createReplayWorld();
});

const pinnedOf = async (id: string): Promise<number | null> => (await world.db.query<{ pinned: number }>('SELECT pinned FROM work_package WHERE inspection_id = ?', [id]))[0]?.pinned ?? null;

describe('setPinned', () => {
  it('pins and unpins a confirmed, healthy package of this account', async () => {
    await seedPkg(world.db, { id: 'a' });
    expect(await setPinned(world.db, ALICE, 'a', true)).toEqual({ ok: true });
    expect(await pinnedOf('a')).toBe(1);
    expect(await setPinned(world.db, ALICE, 'a', false)).toEqual({ ok: true });
    expect(await pinnedOf('a')).toBe(0);
  });

  it('pinning an already-pinned package and unpinning an already-unpinned one both succeed', async () => {
    await seedPkg(world.db, { id: 'a', pinned: 1 });
    expect(await setPinned(world.db, ALICE, 'a', true)).toEqual({ ok: true });
    expect(await pinnedOf('a')).toBe(1);
    await seedPkg(world.db, { id: 'b' });
    expect(await setPinned(world.db, ALICE, 'b', false)).toEqual({ ok: true });
    expect(await pinnedOf('b')).toBe(0);
  });

  it.each([
    ['quarantined', { quarantine: 'reconcile_missing' }, 'quarantined'],
    ['being purged', { purging: 1 }, 'purging'],
    ['not confirmed by the server', { confirmed: 0 }, 'not_confirmed'],
    ["another account's", { owner: BOB }, 'not_found'],
  ] as [string, Omit<Pkg, 'id'>, PinRefusalReason][])(
    'refuses to pin a package that is %s, names the reason, and changes nothing',
    async (_name, spec, reason) => {
      await seedPkg(world.db, { id: 'a', ...spec });
      expect(await setPinned(world.db, ALICE, 'a', true)).toEqual({ ok: false, reason });
      expect(await pinnedOf('a')).toBe(0);
    },
  );

  it.each([
    ['quarantined', { quarantine: 'reconcile_missing' }],
    ['not confirmed by the server', { confirmed: 0 }],
    ['quarantined and not confirmed', { quarantine: 'reconcile_missing', confirmed: 0 }],
  ])('unpins a pinned package that is %s, so a pin can always be taken back', async (_name, spec) => {
    await seedPkg(world.db, { id: 'a', pinned: 1, ...spec });
    expect(await setPinned(world.db, ALICE, 'a', false)).toEqual({ ok: true });
    expect(await pinnedOf('a')).toBe(0);
  });

  it.each([
    ['being purged', { purging: 1 }, 'purging'],
    ["being purged on a person's word", { purging: 2 }, 'purging'],
    ["another account's", { owner: BOB }, 'not_found'],
  ] as [string, Omit<Pkg, 'id'>, PinRefusalReason][])(
    'refuses to unpin a package that is %s, names the reason, and changes nothing',
    async (_name, spec, reason) => {
      await seedPkg(world.db, { id: 'a', pinned: 1, ...spec });
      expect(await setPinned(world.db, ALICE, 'a', false)).toEqual({ ok: false, reason });
      expect(await pinnedOf('a')).toBe(1);
    },
  );

  it('a quarantined package still cannot be PINNED (control for the unpin rule)', async () => {
    await seedPkg(world.db, { id: 'a', quarantine: 'reconcile_missing' });
    expect(await setPinned(world.db, ALICE, 'a', true)).toEqual({ ok: false, reason: 'quarantined' });
    expect(await pinnedOf('a')).toBe(0);
  });

  it('refuses an unknown package and an id that could not be an inspection id', async () => {
    expect(await setPinned(world.db, ALICE, 'missing', true)).toEqual({ ok: false, reason: 'not_found' });
    expect(await setPinned(world.db, ALICE, 'bad id; DROP', true)).toEqual({ ok: false, reason: 'not_an_inspection' });
    expect(await setPinned(world.db, ALICE, 'bulk', true)).toEqual({ ok: false, reason: 'not_an_inspection' });
  });

  it('touches only the named package', async () => {
    await seedPkg(world.db, { id: 'a' });
    await seedPkg(world.db, { id: 'b' });
    await setPinned(world.db, ALICE, 'a', true);
    expect(await pinnedOf('b')).toBe(0);
  });
});
