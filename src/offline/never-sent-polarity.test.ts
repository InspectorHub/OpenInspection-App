import { beforeEach, describe, expect, it } from 'vitest';
import { purgeAuthorityForTest } from './test-support/brands';
import { fingerprintOf } from './reconcile-decision';
import { isNeverSent, purgeInspection } from './purge';
import { createPurgeWorld, type PurgeWorld } from './test-support/purge-world';
import { ALICE } from './test-support/reconcile-world';
import { removeFromDevice, type UserActionDeps } from './user-actions';

/**
 * "Never sent" is the one state in which a person may remove a package that the server did not acknowledge, so the test for
 * it must fail closed: only an exact 0 means never sent. Any other value (a damaged flag included) is treated as a healthy,
 * server-confirmed package, which then follows the normal rules (a person needs a quarantine; automatic mode refuses it).
 */
let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

function deps(): UserActionDeps {
  return { ...world.purgeDeps(), clock: world.clock, account: () => world.state.account, isLocked: () => world.state.locked };
}

async function seed(id: string, flag: number | string): Promise<void> {
  await world.seedFull(id);
  await world.db.run('UPDATE work_package SET server_confirmed = ? WHERE inspection_id = ?', [flag, id]);
}

const damaged: [string, number | string][] = [
  ['2', 2],
  ['-1', -1],
  ['99', 99],
  ['text', 'x'],
];

describe.each(damaged)('a package whose server_confirmed is %s is not "never sent"', (_name, flag) => {
  it('a person-confirmed purge refuses it as not_quarantined and changes nothing', async () => {
    await seed('p2', flag);
    const before = await world.hash();
    const out = await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() });
    expect(out).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(before);
  });

  it('removeFromDevice refuses it as not_quarantined and changes nothing', async () => {
    await seed('p2', flag);
    const before = await world.hash();
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(before);
  });

  it('automatic mode refuses it as unconfirmed', async () => {
    await seed('p2', flag);
    const before = await world.hash();
    const out = await purgeInspection(world.purgeDeps(), 'p2', { mode: 'auto', account: ALICE, expectedFingerprint: await fingerprintOf(world.db, 'p2') });
    expect(out).toEqual({ kind: 'refused', reason: 'unconfirmed' });
    expect(await world.hash()).toBe(before);
  });

  it('a damaged value on a QUARANTINED package follows the normal rule: removable on the person\'s word', async () => {
    await seed('p2', flag);
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'");
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
  });
});

describe('isNeverSent', () => {
  it.each([[0, true], ['0', true], [1, false], [2, false], [-1, false], [null, false], [undefined, false], ['', false], [false, false], [Number.NaN, false], ['x', false]])('%j -> %s', (value, expected) => {
    expect(isNeverSent(value)).toBe(expected);
  });
});

describe('controls', () => {
  it('0 is never sent and stays removable by the person', async () => {
    await seed('p2', 0);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'purged' });
  });

  it('0 is removable through the purge directly as well', async () => {
    await seed('p2', 0);
    expect(await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() })).toEqual({ kind: 'purged' });
  });

  it('1 is healthy: refused as not_quarantined', async () => {
    await seed('p2', 1);
    expect(await removeFromDevice(deps(), 'p2', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
  });
});
