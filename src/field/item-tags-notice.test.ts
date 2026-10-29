import { describe, expect, it } from 'vitest';
import { MAX_REJECTED_COUNT, recordRejected, takeRejected } from './item-tags-notice';
import { accountKey } from '../offline/outbox';
import { resourceWorld } from './test-support/resource-world';
import { ALICE, BOB } from './test-support/seed-package';

const keyOf = (account: typeof ALICE): string => `tag_rejected:${accountKey(account)}`;

async function stored(db: Awaited<ReturnType<typeof resourceWorld>>['db'], key: string): Promise<string | undefined> {
  return (await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]))[0]?.value;
}

describe('the count of tag changes the server refused while no editor was open', () => {
  it('accumulates, and take returns it and clears it', async () => {
    const { db } = await resourceWorld();
    await recordRejected(db, ALICE, 2);
    await recordRejected(db, ALICE, 3);
    expect(await stored(db, keyOf(ALICE))).toBe('5');
    expect(await takeRejected(db, ALICE)).toBe(5);
    expect(await stored(db, keyOf(ALICE))).toBeUndefined();
  });

  it('a second take answers 0', async () => {
    const { db } = await resourceWorld();
    await recordRejected(db, ALICE, 1);
    expect(await takeRejected(db, ALICE)).toBe(1);
    expect(await takeRejected(db, ALICE)).toBe(0);
  });

  it('never taken, nothing is stored and take answers 0', async () => {
    const { db } = await resourceWorld();
    expect(await takeRejected(db, ALICE)).toBe(0);
  });

  it('keeps accounts apart', async () => {
    const { db } = await resourceWorld();
    await recordRejected(db, ALICE, 4);
    expect(await takeRejected(db, BOB)).toBe(0);
    expect(await stored(db, keyOf(ALICE))).toBe('4');
    expect(await takeRejected(db, ALICE)).toBe(4);
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.4])('records nothing for %s', async (count) => {
    const { db } = await resourceWorld();
    await recordRejected(db, ALICE, count);
    expect(await stored(db, keyOf(ALICE))).toBeUndefined();
  });

  it('holds an absurd count at a ceiling, and a sum past it too', async () => {
    const { db } = await resourceWorld();
    await recordRejected(db, ALICE, 5e12);
    expect(await stored(db, keyOf(ALICE))).toBe(String(MAX_REJECTED_COUNT));
    await recordRejected(db, ALICE, 7);
    expect(await takeRejected(db, ALICE)).toBe(MAX_REJECTED_COUNT);
  });

  it.each(['abc', '-4', '3.5', '', '1e9', '99999999999999999999'])('a stored %j counts as none and is cleared by take', async (value) => {
    const { db } = await resourceWorld();
    await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', [keyOf(ALICE), value]);
    expect(await takeRejected(db, ALICE)).toBe(0);
    expect(await stored(db, keyOf(ALICE))).toBeUndefined();
  });

  it('a malformed stored value does not poison later recording', async () => {
    const { db } = await resourceWorld();
    await db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', [keyOf(ALICE), 'garbage']);
    await recordRejected(db, ALICE, 2);
    expect(await takeRejected(db, ALICE)).toBe(2);
  });
});
