import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { photoRecord } from '../media/test-support/fakes';
import { acquireLease, releaseLease, SYNC_LEASE } from '../offline/lease';
import { jsonReply } from '../offline/test-support/package-world';
import { ALICE } from '../offline/test-support/replay-world';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, dbThatFails, type StackWorld } from './test-support/stack-world';

const HOUR = 3_600_000;
const MINT = '/api/inspections/insp-1/media/upload-url';
const TICKET = '/api/inspections/insp-1/collab/ticket';
const KEY = 'tenant-1/inspections/insp-1/photos/p1.jpg';
const OLD = { success: false, error: { code: 'UPGRADE_REQUIRED', message: 'old' } };

async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

function mintAnswers(w: StackWorld): void {
  w.pkg.overrides.set(MINT, () => jsonReply(200, { success: true, data: { url: '/api/public/uploads/photo?token=payload0001.signature0001', key: KEY, expiresAt: 9_999_999_999_999 } }));
}

function ticketAnswers(w: StackWorld): void {
  w.pkg.overrides.set(TICKET, () => jsonReply(200, { success: true, data: { ticket: 'ticket-number-0001-abcdef', expiresIn: 60 } }));
}

/** Four tracked inspections; the server no longer shows `gone-1`. */
async function purgeWorld(): Promise<StackWorld> {
  const w = await createStackWorld();
  w.pkg.overrides.set('/api/client/inspections/visible', (req) => jsonReply(200, { success: true, data: { visible: (JSON.parse(req.body ?? '{}') as { ids: string[] }).ids.filter((id) => id !== 'gone-1') } }));
  for (const id of ['gone-1', 'kept-1', 'kept-2', 'kept-3']) {
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', [id, ALICE.tenantId, ALICE.userId]);
  }
  return w;
}

const rowsOf = async (w: StackWorld): Promise<string[]> => (await w.replay.db.query<{ inspection_id: string }>('SELECT inspection_id FROM work_package ORDER BY inspection_id')).map((r) => r.inspection_id);

/** What happened to `gone-1` at the first reconcile: purged (the row is gone and the editor was told) or kept. */
async function purgeOutcome(w: StackWorld, events: string[]): Promise<'purged' | 'kept'> {
  const gone = !(await rowsOf(w)).includes('gone-1');
  expect(events.includes('purging:gone-1')).toBe(gone);
  return gone ? 'purged' : 'kept';
}

describe('the automatic purge asks whether the inspection is open in an editor', () => {
  it('control: with nothing open the inspection the server no longer shows is purged, and the editor is told', async () => {
    const w = await purgeWorld();
    const stack = w.make();
    const events: string[] = [];
    stack.onEditorEvent((event) => events.push(`${event.kind}:${event.inspectionId}`));
    await run(stack);
    expect(await purgeOutcome(w, events)).toBe('purged');
    expect(await rowsOf(w)).toEqual(['kept-1', 'kept-2', 'kept-3']);
    await stack.stop();
  });

  it('by default an open collaboration connection counts as open: the purge is deferred, and goes ahead once it is closed', async () => {
    const w = await purgeWorld();
    const stack = w.make();
    const events: string[] = [];
    stack.onEditorEvent((event) => events.push(`${event.kind}:${event.inspectionId}`));
    const handle = stack.connector.connect('gone-1', {});
    await run(stack);
    expect(await purgeOutcome(w, events)).toBe('kept');
    expect(stack.reconciler.last.counts).toMatchObject({ purged: 0, deferred: 1 });

    handle.destroy();
    stack.reconciler.trigger('manual');
    await stack.idle();
    expect(await purgeOutcome(w, events)).toBe('purged');
    await stack.stop();
  });

  it('the editor port overrides it, in both directions', async () => {
    const closedButEditing = await purgeWorld();
    const a = closedButEditing.make({ editor: { isOpenInEditor: (id) => id === 'gone-1' } });
    const eventsA: string[] = [];
    a.onEditorEvent((event) => eventsA.push(`${event.kind}:${event.inspectionId}`));
    await run(a);
    expect(await purgeOutcome(closedButEditing, eventsA)).toBe('kept');
    await a.stop();

    const openButNotEditing = await purgeWorld();
    const b = openButNotEditing.make({ editor: { isOpenInEditor: () => Promise.resolve(false) } });
    const eventsB: string[] = [];
    b.onEditorEvent((event) => eventsB.push(`${event.kind}:${event.inspectionId}`));
    b.connector.connect('gone-1', {});
    await run(b);
    expect(await purgeOutcome(openButNotEditing, eventsB)).toBe('purged');
    await b.stop();
  });
});

describe('the editor events', () => {
  it('delivers purging, stops delivering after the unsubscribe, and a failing listener changes nothing', async () => {
    const w = await purgeWorld();
    const stack = w.make();
    const heard: string[] = [];
    const late: string[] = [];
    stack.onEditorEvent(() => {
      throw new Error('a listener that fails');
    });
    stack.onEditorEvent((event) => heard.push(`${event.kind}:${event.inspectionId}`));
    const off = stack.onEditorEvent((event) => late.push(event.kind));
    off();
    await run(stack);
    expect(heard).toContain('purging:gone-1');
    expect(late).toEqual([]);
    expect(await rowsOf(w)).not.toContain('gone-1');
    await stack.stop();
  });
});

describe('the live document of the editor', () => {
  function liveDocWithPendingPhoto(): Y.Doc {
    const doc = new Y.Doc();
    const item = new Y.Map<unknown>();
    const photos = new Y.Array<unknown>();
    const entry = new Y.Map<unknown>();
    entry.set('pendingId', 'p1');
    entry.set('pendingUpload', true);
    entry.set('pendingKind', 'photo');
    photos.push([entry]);
    item.set('photos', photos);
    doc.getMap<unknown>('results').set('finding-1', item);
    return doc;
  }

  it('a photo for an open inspection resolves into the document the editor handed out', async () => {
    const w = await createStackWorld();
    const live = liveDocWithPendingPhoto();
    const stack = w.make({ editor: { liveDoc: (id) => (id === 'insp-1' ? live : null) } });
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.store.markState('p1', 'uploaded', { uploadedKey: KEY });
    stack.connector.connect('insp-1', {});
    await stack.mediaReconciler.reconcileUploads();
    const entry = (live.getMap<Y.Map<unknown>>('results').get('finding-1')?.get('photos') as Y.Array<Y.Map<unknown>>).get(0);
    expect(entry.get('key')).toBe(KEY);
    expect(entry.get('pendingId')).toBeUndefined();
    expect(w.diagnostics).not.toContain('media_error');
    await stack.stop();
  });

  it('a host that cannot hand the document out leaves the photo waiting (DOC_BUSY), file and row kept', async () => {
    const w = await createStackWorld();
    const stack = w.make({ editor: { liveDoc: () => null } });
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await stack.store.markState('p1', 'uploaded', { uploadedKey: KEY });
    stack.connector.connect('insp-1', {});
    await stack.mediaReconciler.reconcileUploads();
    expect(await stack.store.getRow('p1')).not.toBeNull();
    expect(w.diagnostics).toContain('media_error');
    await stack.stop();
  });
});

describe('what the collaboration connector reports', () => {
  it('a socket that cannot be opened is a collaboration issue, not "your edits are not saved"', async () => {
    const w = await createStackWorld();
    ticketAnswers(w);
    const stack = w.make({
      openSocket: () => {
        throw new Error('platform text with ticket=secret');
      },
    });
    await run(stack);
    stack.connector.connect('insp-1', {});
    await vi.waitFor(() => expect(stack.status.get().collabIssue).toBe(true));
    expect(stack.status.get().editsNotSaved).toBe(false);
    expect(w.diagnostics).toContain('collab_error');
    await stack.stop();
  });

  it('a consumer callback that throws is a collaboration issue too', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    const handle = stack.connector.connect('insp-1', {
      onChange: () => {
        throw new Error('the consumer failed');
      },
    });
    await handle.persistenceSynced;
    handle.doc.getMap('results').set('a', 1);
    await vi.waitFor(() => expect(stack.status.get().collabIssue).toBe(true));
    expect(stack.status.get().editsNotSaved).toBe(false);
    handle.destroy();
    await stack.stop();
  });

  it('a document that cannot be written still raises the sticky editsNotSaved (control)', async () => {
    const w = await createStackWorld();
    const stack = w.make({ db: dbThatFails(w.replay.db, { run: /INSERT INTO ydoc_updates/ }) });
    await run(stack);
    const handle = stack.connector.connect('insp-1', {});
    await handle.persistenceSynced;
    handle.doc.getMap('results').set('a', 1);
    await vi.waitFor(() => expect(stack.status.get().editsNotSaved).toBe(true));
    expect(stack.status.get().collabIssue).toBe(false);
    handle.destroy();
    await stack.stop();
  });

  it('a locked device keeps a connection from reaching the server, and the unlock lets it through', async () => {
    const w = await createStackWorld();
    ticketAnswers(w);
    const statuses: string[] = [];
    const stack = w.make({ onCollabStatus: (_id, status) => statuses.push(status) });
    await run(stack);
    w.lock.locked = true;
    w.unlocks.note({ locked: true, reason: 'expired' });
    stack.connector.connect('insp-1', {});
    await vi.waitFor(() => expect(statuses).toContain('locked'));
    expect(w.pkg.requests.some((r) => r.path === TICKET)).toBe(false);

    w.lock.locked = false;
    w.unlocks.note({ locked: false });
    await vi.waitFor(() => expect(w.pkg.requests.some((r) => r.path === TICKET)).toBe(true));
    await stack.stop();
  });
});

describe('status.auth and status.upgrade follow every flow that can be refused', () => {
  it('a reconcile the server refused for the sign-in shows auth, and the next accepted token clears it', async () => {
    const w = await purgeWorld();
    w.pkg.overrides.set('/api/client/session', () => jsonReply(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } }));
    const stack = w.make();
    await run(stack);
    expect(stack.reconciler.last.status).toBe('auth');
    expect(stack.status.get()).toMatchObject({ auth: true, upgrade: false });
    w.verified.fire();
    expect(stack.status.get().auth).toBe(false);
    await stack.stop();
  });

  it('a reconcile the server refused for the app version shows upgrade, and not auth', async () => {
    const w = await purgeWorld();
    w.pkg.overrides.set('/api/client/inspections/visible', () => jsonReply(426, OLD));
    const stack = w.make();
    await run(stack);
    expect(stack.reconciler.last).toMatchObject({ status: 'halt', reason: 'upgrade_required' });
    expect(stack.status.get()).toMatchObject({ auth: false, upgrade: true });
    await stack.stop();
  });

  it.each([
    ['sign-in', 401, { auth: true, upgrade: false }],
    ['app version', 426, { auth: false, upgrade: true }],
  ] as const)('an upload halted for the %s shows it, and an accepted token resumes the uploads', async (_name, status, expected) => {
    const w = await createStackWorld();
    w.pkg.overrides.set(MINT, () => jsonReply(status, status === 426 ? OLD : { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } }));
    // A 401 on the mint that the session check then calls "sign in again" halts the uploads (and only them: nothing else asks).
    const stack = w.make({ tokens: { getAccessToken: () => Promise.resolve('access-token-secret'), checkSession: () => Promise.resolve({ kind: 'relogin' }) } });
    await stack.store.put(photoRecord('p1', { inspectionId: 'insp-1' }));
    await run(stack);
    await vi.waitFor(() => expect(stack.status.get()).toMatchObject(expected));
    expect(w.plugin.starts.length).toBe(0);

    mintAnswers(w);
    w.verified.fire();
    await vi.waitFor(() => expect(w.plugin.starts.length).toBe(1));
    await stack.stop();
  });

  it('a refresh halted for the sign-in sets auth only, and one halted for the app version sets upgrade only', async () => {
    const w = await createStackWorld();
    const signedOut = w.make({ tokens: { getAccessToken: () => Promise.resolve(null), checkSession: w.tokensCheck } });
    await signedOut.refresher.refresh({ reason: 'manual' });
    expect(signedOut.status.get()).toMatchObject({ auth: true, upgrade: false });
    await signedOut.stop();

    const old = w.make();
    w.pkg.script.push(jsonReply(426, OLD));
    await old.refresher.refresh({ reason: 'manual' });
    expect(old.status.get()).toMatchObject({ auth: false, upgrade: true });
    await old.stop();
  });
});

describe('a refresh turned away by another holder of the lease', () => {
  it('does not wake the reconciler: nothing was refreshed', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    w.replay.clock.advance(2 * HOUR);
    const before = stack.reconciler.last.at;
    const foreign = await acquireLease(w.replay.db, SYNC_LEASE, { clock: w.replay.clock });
    const turnedAway = await stack.refresher.refresh({ reason: 'manual' });
    await stack.idle();
    expect(turnedAway.leaseBusy).toBe(true);
    expect(stack.reconciler.last.at).toBe(before);
    await releaseLease(w.replay.db, SYNC_LEASE, foreign ?? '');
    await stack.stop();
  });
});

describe('the diagnostics the stack keeps', () => {
  it('records the fixed codes it reported, oldest first, and nothing else', async () => {
    const w = await createStackWorld();
    const files = {
      ...w.files,
      list: () => Promise.reject(new Error('/data/secret/path.jpg could not be listed')),
    };
    const stack = w.make({ files });
    expect(stack.recentDiagnostics()).toEqual([]);
    await run(stack);
    expect(w.diagnostics).toContain('sweep_failed');
    expect(stack.recentDiagnostics()).toEqual(w.diagnostics);
    expect(JSON.stringify(stack.recentDiagnostics())).not.toContain('secret');
    await stack.stop();
  });
});

describe('the stack hands out its document access', () => {
  it('runs a function against the results document of an inspection that is not blocked', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    const out = await stack.withDoc('insp-1', (doc) => {
      doc.getMap<unknown>('results').set('k', 1);
      return 'ran';
    });
    expect(out).toBe('ran');
    await stack.stop();
  });

  it('rejects with BLOCKED, without running the function, for a blocked inspection', async () => {
    const w = await createStackWorld();
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, purging) VALUES (?, 1, 0, 1, ?, ?, 1)', ['gone-1', ALICE.tenantId, ALICE.userId]);
    const stack = w.make();
    const fn = vi.fn();
    await expect(stack.withDoc('gone-1', fn)).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(fn).not.toHaveBeenCalled();
    await stack.stop();
  });
});
