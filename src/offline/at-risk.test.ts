import { describe, expect, it } from 'vitest';
import { createListWorld, seedMedia, seedPkg, seedQueued } from '../ui/test-support/worklist-world';
import { countAtRisk } from './at-risk';

describe('countAtRisk', () => {
  it('is zero on an empty device', async () => {
    const { db } = await createListWorld();
    expect(await countAtRisk(db)).toEqual({ waiting: 0, orphaned: 0, createdHere: 0, total: 0 });
  });

  it('counts waiting uploads, orphaned writes and inspections the server never confirmed, and sums them', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a' });
    await seedPkg(db, { id: 'local', confirmed: 0 });
    await seedMedia(db, 'p1', 'a', 'pending');
    await seedMedia(db, 'p2', 'a', 'failed');
    await seedMedia(db, 'done', 'a', 'uploaded');
    await seedQueued(db, { key: 'k1', seq: 1, inspectionId: 'a' });
    await seedQueued(db, { key: 'k2', seq: 2, inspectionId: 'a', state: 'orphaned' });
    expect(await countAtRisk(db)).toEqual({ waiting: 3, orphaned: 1, createdHere: 1, total: 5 });
  });

  it('control: things already on the server are not at risk', async () => {
    const { db } = await createListWorld();
    await seedPkg(db, { id: 'a', confirmed: 1 });
    await seedMedia(db, 'done', 'a', 'uploaded');
    expect((await countAtRisk(db)).total).toBe(0);
  });
});
