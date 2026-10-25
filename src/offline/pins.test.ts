import { beforeEach, describe, expect, it } from 'vitest';
import { setPinned } from './pins';
import { createReplayWorld, ALICE, BOB, type ReplayWorld } from './test-support/replay-world';
import { seedPkg } from '../ui/test-support/worklist-world';

let world: ReplayWorld;

beforeEach(async () => {
  world = await createReplayWorld();
});

const pinnedOf = async (id: string): Promise<number | null> => (await world.db.query<{ pinned: number }>('SELECT pinned FROM work_package WHERE inspection_id = ?', [id]))[0]?.pinned ?? null;

describe('setPinned', () => {
  it('pins and unpins a confirmed, healthy package of this account', async () => {
    await seedPkg(world.db, { id: 'a' });
    expect(await setPinned(world.db, ALICE, 'a', true)).toBe(true);
    expect(await pinnedOf('a')).toBe(1);
    expect(await setPinned(world.db, ALICE, 'a', false)).toBe(true);
    expect(await pinnedOf('a')).toBe(0);
  });

  it.each([
    ['quarantined', { quarantine: 'reconcile_missing' }],
    ['being purged', { purging: 1 }],
    ['not confirmed by the server', { confirmed: 0 }],
    ['another account\'s', { owner: BOB }],
  ])('refuses a package that is %s and changes nothing', async (_name, spec) => {
    await seedPkg(world.db, { id: 'a', ...spec });
    expect(await setPinned(world.db, ALICE, 'a', true)).toBe(false);
    expect(await pinnedOf('a')).toBe(0);
  });

  it('refuses an unknown package and an id that could not be an inspection id', async () => {
    expect(await setPinned(world.db, ALICE, 'missing', true)).toBe(false);
    expect(await setPinned(world.db, ALICE, 'bad id; DROP', true)).toBe(false);
    expect(await setPinned(world.db, ALICE, 'bulk', true)).toBe(false);
  });

  it('touches only the named package', async () => {
    await seedPkg(world.db, { id: 'a' });
    await seedPkg(world.db, { id: 'b' });
    await setPinned(world.db, ALICE, 'a', true);
    expect(await pinnedOf('b')).toBe(0);
  });
});
