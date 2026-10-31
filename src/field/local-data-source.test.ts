import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordRejected, takeRejected } from './item-tags-notice';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { listOutbox } from '../offline/outbox';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { MESSAGES } from './messages';
import { PHOTO_PLACEHOLDER_URL, createMemoryPhotoIndex } from './photo-urls';
import { world } from './test-support/data-source-world';
import { photosOf, removePhotos, seedPhotos } from './test-support/doc-seed';
import { createDeferredResolveVideo } from './video-adapter';

afterEach(() => {
  restoreGlobals();
});

describe('the assembled data source', () => {
  it('carries every member the editor asks for, and no list address (a native shell has no pages)', async () => {
    const { source } = await world();
    expect(Object.keys(source).sort()).toEqual(['collab', 'exit', 'execute', 'isOnline', 'load', 'media', 'notify', 'onOnlineChange', 'openUrl', 'platform', 'reload', 'resources', 'session', 'urls'].sort());
    expect(Object.keys(source.resources).sort()).toEqual(['aiAssist', 'commentsLibrary', 'costItems', 'itemTags', 'mediaPool', 'prefs', 'publishReadiness', 'repairItems', 'settingsSheet', 'templateSearch', 'versionHistory', 'video']);
    expect(source.urls.inspectionsList).toBeUndefined();
    expect(source.platform).toBe('android');
    expect(Object.keys(source.media).sort()).toEqual(['store', 'uploader']);
  });

  it('exposes a host image decoder only when one is supplied', async () => {
    const decodeImage = async () => null;
    const withDecoder = await world({ decodeImage });
    const withoutDecoder = await world();

    expect(withDecoder.source.media.decodeImage).toBe(decodeImage);
    expect(withoutDecoder.source.media.decodeImage).toBeUndefined();
  });

  it('the editor-facing itemTags keeps a tag on the device and reads it back', async () => {
    const w = await world();
    w.online.value = false;
    const tags = w.source.resources.itemTags;
    expect(tags).toBeDefined();
    expect(await tags?.add(INSPECTION, 'item-1', 'tag-urgent')).toEqual({ ok: true });
    expect((await tags?.list(INSPECTION))?.['item-1']?.map((t) => t.id)).toEqual(['tag-urgent']);
    expect(await tags?.remove(INSPECTION, 'item-1', 'tag-urgent')).toEqual({ ok: true });
    expect((await tags?.list(INSPECTION))?.['item-1'] ?? []).toEqual([]);
  });

  it('tells the person once, on the next load, about tag changes refused while no editor was open', async () => {
    const w = await world();
    await recordRejected(w.db, w.stack.account, 2);
    await w.source.load(INSPECTION);
    expect(w.notes).toEqual([[MESSAGES.tagsNotSynced, 'warning']]);
    await w.source.load(INSPECTION);
    expect(w.notes).toHaveLength(1);
  });

  it('says nothing when nothing was refused, and another account\'s count is not told', async () => {
    const w = await world();
    await recordRejected(w.db, { tenantId: 'tenant-1', userId: 'someone-else' }, 2);
    await w.source.load(INSPECTION);
    expect(w.notes).toEqual([]);
  });

  it('a load still succeeds when the count cannot be read', async () => {
    const errors: unknown[] = [];
    const quiet = await world({ onError: (e) => errors.push(e) });
    await recordRejected(quiet.db, quiet.stack.account, 1);
    quiet.db.transaction = () => Promise.reject(new Error('disk full'));
    await expect(quiet.source.load(INSPECTION)).resolves.toBeDefined();
    expect(errors).toHaveLength(1);
    expect(quiet.notes).toEqual([]);
  });

  it('a refusal the editor itself meets is told at once and is not also kept for the next load', async () => {
    const w = await world();
    w.api.send = () => Promise.resolve({ kind: 'response', status: 404, json: {} });
    expect(await w.source.resources.itemTags?.add(INSPECTION, 'item-1', 'tag-x')).toEqual({ ok: true });
    await vi.waitFor(() => expect(w.notes).toEqual([[MESSAGES.tagsNotSynced, 'warning']]));
    expect(await takeRejected(w.db, w.stack.account)).toBe(0);
    await w.source.load(INSPECTION);
    expect(w.notes).toHaveLength(1);
  });

  it('restartSession is offered only when the screen can restart', async () => {
    expect((await world()).source.restartSession).toBeUndefined();
    let restarts = 0;
    const w = await world({ onRestart: () => void (restarts += 1) });
    w.source.restartSession?.();
    expect(restarts).toBe(1);
  });

  it('session is the snapshot it was given: presence is off, and the shared collaboration model is on', async () => {
    const { source } = await world();
    expect(source.session().userId).toBeNull();
    expect(source.session().collabEditing).toBe(true);
  });
});

describe('load', () => {
  it('answers the downloaded inspection', async () => {
    const { source } = await world();
    const data = await source.load(INSPECTION);
    expect(data.inspection.id).toBe(INSPECTION);
    expect(Object.keys(data.results).some((key) => key.startsWith('_default:'))).toBe(true);
  });

  it('a blocked inspection is refused (control: the same call succeeds before the block)', async () => {
    const w = await world();
    await expect(w.source.load(INSPECTION)).resolves.toBeDefined();
    await w.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', [INSPECTION]);
    await expect(w.source.load(INSPECTION)).rejects.toThrow(MESSAGES.blocked);
  });

  it('indexes the photos that are already on the server but still on the device, so urls.photo can show them', async () => {
    const index = createMemoryPhotoIndex();
    const w = await world({ photoIndex: index });
    const key = `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`;
    await w.store.put(photoRecord('p1'));
    await w.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: key });
    expect(w.source.urls.photo(INSPECTION, key)).toBe(PHOTO_PLACEHOLDER_URL);
    await w.source.load(INSPECTION);
    expect(w.source.urls.photo(INSPECTION, key)).not.toBe(PHOTO_PLACEHOLDER_URL);
  });
});

describe('execute', () => {
  it('complete is queued for the replayer and the reloaded data already shows it done', async () => {
    const w = await world();
    expect(await w.source.execute(INSPECTION, { type: 'complete' })).toEqual({ ok: true });
    expect((await listOutbox(w.db, {})).map((row) => row.op)).toEqual(['inspection.complete']);
    expect((await w.source.load(INSPECTION)).inspection.status).toBe('completed');
  });

  it('a command that needs the server says so offline, with the sentence and not the code (control: online it is sent)', async () => {
    const w = await world();
    w.online.value = false;
    const offline = await w.source.execute(INSPECTION, { type: 'sign-inspector', signatureBase64: 'abc' });
    expect(offline).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(w.api.calls).toHaveLength(0);
    w.online.value = true;
    await w.source.execute(INSPECTION, { type: 'sign-inspector', signatureBase64: 'abc' });
    expect(w.api.calls[0]?.json).toMatchObject({ signatureBase64: 'abc', signedAt: 5000 });
  });
});

describe('leaving, reloading, links, messages', () => {
  it('exit leaves the screen and asks the reconciler to look again; a failing reconciler does not stop it', async () => {
    const w = await world();
    expect(w.exits).toBe(0);
    expect(w.triggers).toEqual([]);
    w.source.exit();
    expect(w.exits).toBe(1);
    expect(w.triggers).toEqual(['follow_up']);
    const broken = await world({ stack: { ...w.stack, reconciler: { trigger: () => { throw new Error('boom'); } } }, onError: () => undefined });
    expect(() => broken.source.exit()).not.toThrow();
    expect(broken.exits).toBe(1);
  });

  it('reload re-reads, notify reaches the sink (default variant info), and a failing sink does not break the editor', async () => {
    const w = await world();
    w.source.reload();
    expect(w.reloads).toBe(1);
    w.source.notify('Saved.');
    w.source.notify('Careful.', 'warning');
    expect(w.notes).toEqual([['Saved.', 'info'], ['Careful.', 'warning']]);
    const errors: unknown[] = [];
    const broken = await world({ notify: () => { throw new Error('toast host gone'); }, onError: (e) => errors.push(e) });
    expect(() => broken.source.notify('x')).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('openUrl hands only https addresses to the system browser; anything else is a warning and nothing opens', async () => {
    const w = await world();
    w.source.openUrl?.('https://example.com/report');
    expect(w.opened).toEqual(['https://example.com/report']);
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'not a url', '']) w.source.openUrl?.(bad);
    expect(w.opened).toHaveLength(1);
    expect(w.notes.filter(([message]) => message === MESSAGES.linkBlocked)).toHaveLength(6);
  });

  it('a system browser that refuses is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const w = await world({ openExternal: () => Promise.reject(new Error('no browser')), onError: (e) => errors.push(e) });
    w.source.openUrl?.('https://example.com');
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});

describe('urls', () => {
  it('has no server pages, a download address that goes nowhere, and an editor path that is the same each time', async () => {
    const { source } = await world();
    const urls = source.urls;
    expect(urls.reportPreview('acme', INSPECTION)).toBeNull();
    expect(urls.reportPdf(INSPECTION)).toBeNull();
    expect(urls.statutoryPreviewPdf(INSPECTION)).toBeNull();
    expect(urls.videoObject(INSPECTION, 'ref')).toBeNull();
    expect(urls.costExport).toBeUndefined();
    expect('costExport' in urls).toBe(false);
    expect(urls.editorPath(INSPECTION)).toBe(`/inspections/${INSPECTION}/edit`);
    expect(urls.editorPath(INSPECTION)).toBe(urls.editorPath(INSPECTION));
    expect(urls.presenceSocket(INSPECTION)).toMatch(/^wss:\/\/[^/]+\.invalid\//);
    expect(urls.presenceSocket(INSPECTION)).not.toMatch(/token|ticket/i);
  });

  it('refuses a photo key of another company or inspection, and gives a marked placeholder for one it has no copy of', async () => {
    const index = createMemoryPhotoIndex();
    const { source } = await world({ photoIndex: index });
    const own = `tenant-1/inspections/${INSPECTION}/photos/a.jpg`;
    index.set(INSPECTION, [[own, 'http://localhost/_capacitor_file_/media/a.jpg'], ['tenant-2/inspections/insp-1/photos/a.jpg', 'http://localhost/x.jpg']]);
    expect(source.urls.photo(INSPECTION, own)).toBe('http://localhost/_capacitor_file_/media/a.jpg');
    expect(source.urls.photo(INSPECTION, 'tenant-2/inspections/insp-1/photos/a.jpg')).toBe(PHOTO_PLACEHOLDER_URL);
    expect(source.urls.photo(INSPECTION, `tenant-1/inspections/${INSPECTION}/photos/none.jpg`)).toBe(PHOTO_PLACEHOLDER_URL);
  });
});

describe('collaboration and media', () => {
  it('the editor registry sees the open document of a connection, and a photo removed from it loses its device row', async () => {
    const w = await world();
    await w.store.put(photoRecord('p1'));
    const opened = w.source.collab.connect(INSPECTION, {});
    expect(w.registry.getHandle(INSPECTION)).not.toBeNull();
    seedPhotos(opened.doc, '_default:s1:i1', [{ key: '', pendingUpload: true, pendingId: 'p1', pendingKind: 'photo' }]);
    removePhotos(opened.doc, '_default:s1:i1', () => true);
    for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await w.store.listRows()).toEqual([]);
    expect(photosOf(opened.doc, '_default:s1:i1')).toEqual([]);
    opened.destroy();
    expect(w.registry.getHandle(INSPECTION)).toBeNull();
  });

  it('an item photo and a defect photo both go to the background uploader, neither to the foreground request', async () => {
    const w = await world();
    w.api.calls.length = 0;
    const uploader = w.source.media.uploader(INSPECTION, null);
    expect((await uploader.upload(photoRecord('p1') as PendingMediaRecord)).ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1']);
    expect(w.api.calls).toHaveLength(0);
    const defect: PendingMediaRecord = { ...photoRecord('p2'), meta: { targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'c1', defectKind: 'custom' } };
    expect((await uploader.upload(defect)).ok).toBe(true);
    expect(w.nativeCalls).toEqual(['p1', 'p2']);
    expect(w.api.calls).toHaveLength(0);
  });

  it('binds the clip document step of the stack to the real one: unbound it keeps every file, bound it resolves a finished clip', async () => {
    const deferred = createDeferredResolveVideo();
    const key = `tenant-1/inspections/${INSPECTION}/videos/local-x.mp4`;
    const ref = { provider: 'r2', mediaId: 'local-x', r2Key: key } as const;
    const w = await world({ resolveVideo: deferred, newId: () => 'x' });
    w.online.value = false;
    const ticket = (await w.source.resources.video?.createUpload(INSPECTION, {}))?.data;
    if (ticket === undefined) throw new Error('no ticket');
    await w.source.resources.video?.uploadFile(ticket, new File([new Uint8Array(64).fill(1)], 'c.mp4', { type: 'video/mp4' }), () => undefined);
    await w.store.markState('local-x', 'uploaded', { attempts: 0, uploadedKey: key });
    expect(await deferred.resolveVideo(INSPECTION, 'local-x', ref)).toBe('resolved');
    // Control: the step handed out before anything is bound answers "missing" for the very same clip.
    expect(await createDeferredResolveVideo().resolveVideo(INSPECTION, 'local-x', ref)).toBe('missing');
  });
});

describe('under the browser rule for builtins', () => {
  it('records a clip on the device without a connection, with the default id source (crypto.randomUUID) called the way a web view demands', async () => {
    const w = await world();
    installStrictGlobals();
    w.online.value = false;
    const created = await w.source.resources.video?.createUpload(INSPECTION, {});
    expect(created?.ok).toBe(true);
    const ticket = created?.data;
    if (ticket === undefined) throw new Error('no ticket');
    expect(ticket.ref.provider === 'r2' && ticket.ref.mediaId.startsWith('local-')).toBe(true);
    const file = new File([new Uint8Array(64).fill(1)], 'c.mp4', { type: 'video/mp4' });
    expect((await w.source.resources.video?.uploadFile(ticket, file, () => undefined))?.ok).toBe(true);
    expect(await w.store.listRows({ kinds: ['video'] })).toHaveLength(1);
  });

  it('a resource read goes through the Bearer client only (no builtin of its own)', async () => {
    const w = await world();
    installStrictGlobals();
    w.api.calls.length = 0;
    expect(await w.source.resources.commentsLibrary?.list()).toEqual([]);
    expect(w.api.calls).toHaveLength(1);
  });
});
