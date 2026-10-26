import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import { createPurgeWorld, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';
import { discardMedia, type UserActionDeps } from './user-actions';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

function deps(overrides: Partial<UserActionDeps> = {}): UserActionDeps {
  return { ...world.purgeDeps(), clock: world.clock, account: () => world.state.account, isLocked: () => world.state.locked, ...overrides };
}

const DEFECT_META = JSON.stringify({ targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'd1', defectKind: 'custom' });
const ITEM_META = JSON.stringify({ targetType: 'item', findingKey: '_default:s1:i1', itemId: 'i1' });

async function photo(inspectionId: string, pendingId: string, options: { meta?: string; state?: string; attempts?: number; kind?: string } = {}): Promise<void> {
  const path = `media/${pendingId}.jpg`;
  await world.files.write(path, new Uint8Array([1, 2, 3]));
  await world.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', [pendingId, inspectionId, options.kind ?? 'photo', path, 'image/jpeg', options.meta ?? DEFECT_META, options.state ?? 'failed', options.attempts ?? MAX_UPLOAD_ATTEMPTS]);
}

const ids = async (): Promise<string[]> => (await world.db.query<{ pending_id: string }>('SELECT pending_id FROM media ORDER BY pending_id')).map((r) => r.pending_id);

describe('discardMedia: a defect photo that stopped for good can be discarded from a healthy inspection of this account', () => {
  it('removes the file and the row, and only that photo', async () => {
    await world.pkg('h1');
    await photo('h1', 'stuck');
    await photo('h1', 'neighbour');
    expect(await discardMedia(deps(), 'stuck', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'h1' });
    expect(await ids()).toEqual(['neighbour']);
    expect(world.files.paths()).toEqual(['media/neighbour.jpg']);
  });

  it.each<[string, { meta?: string; state?: string; attempts?: number; kind?: string }]>([
    ['an item photo at the limit (it has an entry in the document)', { meta: ITEM_META }],
    ['a defect photo still being retried (below the limit)', { attempts: MAX_UPLOAD_ATTEMPTS - 1 }],
    ['a defect photo that is pending', { state: 'pending', attempts: 0 }],
    ['a defect photo that is uploading', { state: 'uploading', attempts: 0 }],
    ['a defect photo already uploaded', { state: 'uploaded', attempts: 0 }],
    ['a clip whose meta names a defect', { kind: 'video' }],
    ['a photo whose meta cannot be read', { meta: 'not json' }],
  ])('still refuses %s, changes nothing, and the control row of the same inspection is removed', async (_name, options) => {
    await world.pkg('h1');
    await photo('h1', 'refused', options);
    await photo('h1', 'control');
    const hash = await world.hash();
    expect(await discardMedia(deps(), 'refused', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    expect(await world.hash()).toBe(hash);
    expect(world.files.paths()).toContain('media/refused.jpg');
    expect(await discardMedia(deps(), 'control', { confirmed: true })).toEqual({ kind: 'discarded', inspectionId: 'h1' });
  });

  it("refuses another account's stuck defect photo (the account check is not relaxed), and removes this account's", async () => {
    await world.pkg('b1', { account: BOB });
    await photo('b1', 'bobs');
    await world.pkg('a1', { account: ALICE });
    await photo('a1', 'mine');
    expect(await discardMedia(deps(), 'bobs', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    expect(await ids()).toEqual(['bobs', 'mine']);
    expect(await discardMedia(deps(), 'mine', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });

  it('a package with only half an owner is nobody\'s: refused (control: the full owner is removed)', async () => {
    await world.pkg('h1');
    await photo('h1', 'half');
    await world.db.run('UPDATE work_package SET user_id = NULL WHERE inspection_id = ?', ['h1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toEqual({ kind: 'refused', reason: 'not_removable' });
    await world.db.run('UPDATE work_package SET user_id = ? WHERE inspection_id = ?', [ALICE.userId, 'h1']);
    expect(await discardMedia(deps(), 'half', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });

  it('a photo of an inspection a purge decided on its own is still left to that purge', async () => {
    await world.pkg('a1', { purging: 1 });
    await photo('a1', 'ap');
    expect(await discardMedia(deps(), 'ap', { confirmed: true })).toEqual({ kind: 'refused', reason: 'purging' });
    expect(await ids()).toEqual(['ap']);
  });

  it('is refused while the device is locked, and without a signed-in account', async () => {
    await world.pkg('h1');
    await photo('h1', 'stuck');
    expect(await discardMedia(deps({ isLocked: () => true }), 'stuck', { confirmed: true })).toEqual({ kind: 'locked' });
    expect(await discardMedia(deps({ account: () => null }), 'stuck', { confirmed: true })).toEqual({ kind: 'refused', reason: 'no_account' });
    expect(await ids()).toEqual(['stuck']);
    expect(await discardMedia(deps(), 'stuck', { confirmed: true })).toMatchObject({ kind: 'discarded' });
  });
});
