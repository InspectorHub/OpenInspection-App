import { describe, expect, it } from 'vitest';
import type { VideoUploadTicket } from '@inspectorhub/field-ui';
import { isMediaError } from '../media/errors';
import { MAX_VIDEO_BYTES } from '../media/store';
import { INSPECTION, ORIGIN } from '../media/test-support/fakes';
import type { ApiOutcome } from './api-client';
import { MESSAGES } from './messages';
import { formFields, reply } from './test-support/scripted-api';
import { clip, need, R2_KEY, setup, ticketAnswer, TOKEN } from './test-support/video-world';

describe('recording without a connection', () => {
  it('answers a local ticket, keeps the clip on the device, answers a synthetic reference and an empty pool id, and sends nothing', async () => {
    const s = await setup({ online: false });
    const created = await s.adapter.video.createUpload(INSPECTION, { itemId: 'i1' });
    expect(created.ok).toBe(true);
    const ticket = need(created.data);
    expect(ticket.provider).toBe('r2');
    const uploaded = await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    expect(uploaded.ok).toBe(true);
    const mediaId = uploaded.data?.mediaId ?? '';
    expect(mediaId).toBe('local-id1');
    expect(uploaded.data?.r2Key).toBe('local/local-id1.mp4');

    const rows = await s.world.store.listRows({ inspectionId: INSPECTION });
    expect(rows.map((row) => [row.pendingId, row.kind, row.contentType, row.state, JSON.parse(row.meta)])).toEqual([['local-id1', 'video', 'video/mp4', 'pending', { itemId: 'i1' }]]);

    const poster = await s.adapter.video.uploadPoster(INSPECTION, ticket, new Blob(['p'], { type: 'image/jpeg' }));
    expect(poster.ok).toBe(false);
    const finalized = await s.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId, r2Key: uploaded.data?.r2Key ?? '' });
    expect(finalized).toEqual({ ok: true, data: { poolId: '' } });
    expect(s.api.calls).toEqual([]);
  });

  it('progress reaches 100 when the clip is stored', async () => {
    const s = await setup({ online: false });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    const seen: number[] = [];
    await s.adapter.video.uploadFile(ticket, clip(), (pct) => seen.push(pct));
    expect(seen.at(-1)).toBe(100);
  });

  it('a Stream company records locally too, even with a connection: the app cannot post to the Stream host itself', async () => {
    const s = await setup({ online: true, provider: 'stream' });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    expect(ticket.ref).toEqual({ provider: 'stream', streamUid: 'local-id1' });
    expect(await s.adapter.video.uploadFile(ticket, clip('video/quicktime'), () => undefined)).toEqual({ ok: true });
    const row = need((await s.world.store.listRows())[0]);
    expect(row.contentType).toBe('video/quicktime');
    expect(await s.adapter.video.finalize(INSPECTION, { provider: 'stream', streamUid: 'local-id1' })).toEqual({ ok: true, data: { poolId: '' } });
    expect(s.api.calls).toEqual([]);
  });

  it('refuses a clip the store would refuse, with a sentence, and keeps nothing', async () => {
    const s = await setup({ online: false });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    expect(await s.adapter.video.uploadFile(ticket, clip('video/x-matroska'), () => undefined)).toMatchObject({ ok: false, error: MESSAGES.videoTypeUnsupported });
    const huge = clip();
    Object.defineProperty(huge, 'size', { value: MAX_VIDEO_BYTES + 1 });
    expect(await s.adapter.video.uploadFile(ticket, huge, () => undefined)).toMatchObject({ ok: false, error: MESSAGES.videoTooLarge });
    expect(await s.world.store.listRows()).toEqual([]);
    // Control: the same ticket takes a good clip.
    expect((await s.adapter.video.uploadFile(ticket, clip(), () => undefined)).ok).toBe(true);
  });

  it('finalize answers success only for a clip that is really stored', async () => {
    const s = await setup({ online: false });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    const notStored = await s.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId: 'local-id1', r2Key: 'local/local-id1.mp4' });
    expect(notStored).toMatchObject({ ok: false, error: MESSAGES.videoNotPrepared });
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    expect((await s.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId: 'local-id1', r2Key: 'local/local-id1.mp4' })).ok).toBe(true);
  });

  it('a ticket this adapter did not hand out is not stored from', async () => {
    const s = await setup({ online: false });
    const forged: VideoUploadTicket = { uploadURL: 'x', provider: 'r2', ref: { provider: 'r2', mediaId: 'local-evil', r2Key: 'local/local-evil.mp4' } };
    const result = await s.adapter.video.uploadFile(forged, clip(), () => undefined);
    expect(result.ok).toBe(false);
    expect(await s.world.store.listRows()).toEqual([]);
    expect(s.api.calls).toEqual([]);
  });

  it('a blocked inspection records nothing', async () => {
    const s = await setup({ online: false });
    s.state.blocked = true;
    expect(await s.adapter.video.createUpload(INSPECTION, {})).toEqual({ ok: false, error: MESSAGES.blocked });
    s.state.blocked = false;
    expect((await s.adapter.video.createUpload(INSPECTION, {})).ok).toBe(true);
  });

  it('a full disk answers a sentence and keeps no row', async () => {
    const s = await setup({ online: false });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    s.world.files.failWrites();
    expect(await s.adapter.video.uploadFile(ticket, clip(), () => undefined)).toMatchObject({ ok: false, error: MESSAGES.videoDiskFull });
    expect(await s.world.store.listRows()).toEqual([]);
  });
});

describe('recording with a connection (R2)', () => {
  it('uses the engine routes in the web order: create-upload, the clip to its token route, the poster, finalize', async () => {
    const s = await setup({
      answers: [ticketAnswer(), reply(200, { data: { mediaId: 'm1', r2Key: R2_KEY } }), reply(200, { data: { posterKey: 'poster-key' } }), reply(200, { data: { poolId: 'pool-9' } })],
    });
    const created = await s.adapter.video.createUpload(INSPECTION, { itemId: 'i1' });
    const ticket = need(created.data);
    // The address is rebuilt on the pinned origin: the engine names itself by its own public one.
    expect(ticket.uploadURL).toBe(`${ORIGIN}/api/public/uploads/video?token=${TOKEN}`);
    const progress: number[] = [];
    const uploaded = await s.adapter.video.uploadFile(ticket, clip(), (pct) => progress.push(pct));
    expect(uploaded).toEqual({ ok: true, data: { mediaId: 'm1', r2Key: R2_KEY } });
    expect(progress.at(-1)).toBe(100);
    const poster = await s.adapter.video.uploadPoster(INSPECTION, ticket, new Blob(['p'], { type: 'image/jpeg' }));
    expect(poster).toEqual({ ok: true, data: { posterKey: 'poster-key' } });
    const finalized = await s.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId: 'm1', r2Key: R2_KEY, posterKey: 'poster-key' });
    expect(finalized).toEqual({ ok: true, data: { poolId: 'pool-9' } });

    expect(s.api.calls.map((call) => [call.method, call.path, call.query])).toEqual([
      ['POST', `/api/inspections/${INSPECTION}/media/video/create-upload`, undefined],
      ['POST', '/api/public/uploads/video', { token: TOKEN }],
      ['POST', `/api/inspections/${INSPECTION}/media/video/r2-upload-poster`, { token: TOKEN }],
      ['POST', `/api/inspections/${INSPECTION}/media/video/finalize`, undefined],
    ]);
    expect(s.api.calls[0]?.json).toEqual({ itemId: 'i1' });
    expect(formFields(s.api.calls[1]?.form)).toEqual({ file: 'file:clip.mp4' });
    expect(formFields(s.api.calls[2]?.form)).toEqual({ file: 'file:poster.jpg' });
    expect(s.api.calls[3]?.json).toEqual({ provider: 'r2', mediaId: 'm1', r2Key: R2_KEY, posterKey: 'poster-key' });
    expect(await s.world.store.listRows()).toEqual([]);
  });

  it('refuses a ticket that points anywhere but the engine upload route, and one that is not R2', async () => {
    const elsewhere = await setup({ answers: [ticketAnswer({ uploadURL: `https://evil.example.com/steal?token=${TOKEN}` })] });
    expect(await elsewhere.adapter.video.createUpload(INSPECTION, {})).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
    const stream = await setup({ answers: [ticketAnswer({ provider: 'stream', ref: { provider: 'stream', streamUid: 'abcdefgh1234' } })] });
    expect(await stream.adapter.video.createUpload(INSPECTION, {})).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
    const noRef = await setup({ answers: [ticketAnswer({ ref: undefined })] });
    expect((await noRef.adapter.video.createUpload(INSPECTION, {})).ok).toBe(false);
  });

  it('says what happened when the engine refuses or cannot be reached', async () => {
    const cases: [ApiOutcome, string][] = [
      [reply(403), MESSAGES.forbidden],
      [reply(500), MESSAGES.requestFailed],
      [{ kind: 'problem', problem: 'offline' }, MESSAGES.needsConnection],
      [{ kind: 'problem', problem: 'locked' }, MESSAGES.deviceLocked],
    ];
    for (const [answer, sentence] of cases) {
      const s = await setup({ answers: [answer] });
      expect(await s.adapter.video.createUpload(INSPECTION, {}), sentence).toEqual({ ok: false, error: sentence });
    }
  });

  it('the clip upload: a refusal for size, a lost answer and a body without references are all sentences', async () => {
    const make = async (answer: ApiOutcome) => {
      const s = await setup({ answers: [ticketAnswer(), answer] });
      const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
      return s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    };
    expect(await make(reply(413))).toEqual({ ok: false, error: MESSAGES.videoTooLarge });
    expect(await make({ kind: 'problem', problem: 'unknown' })).toEqual({ ok: false, error: MESSAGES.outcomeUnknown });
    expect(await make(reply(200, { data: {} }))).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
    expect(await make(reply(500))).toEqual({ ok: false, error: MESSAGES.requestFailed });
  });

  it('a poster that cannot be stored is not fatal: it answers not-ok and nothing else', async () => {
    const s = await setup({ answers: [ticketAnswer(), reply(500)] });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    expect((await s.adapter.video.uploadPoster(INSPECTION, ticket, new Blob(['p']))).ok).toBe(false);
  });

  it('finalize that lost its answer says the outcome is unknown; a refusal carries the server sentence', async () => {
    const lost = await setup({ answers: [{ kind: 'problem', problem: 'unknown' }] });
    expect(await lost.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId: 'm1', r2Key: R2_KEY })).toEqual({ ok: false, error: MESSAGES.outcomeUnknown });
    const refused = await setup({ answers: [reply(400, { error: { message: 'The video service is out of quota.' } })] });
    expect(await refused.adapter.video.finalize(INSPECTION, { provider: 'r2', mediaId: 'm1', r2Key: R2_KEY })).toEqual({ ok: false, error: 'The video service is out of quota.' });
  });
});

describe('details that were found by mutation', () => {
  it('an online answer whose provider and reference disagree is refused (control: the consistent one is taken)', async () => {
    const mixed1 = await setup({ answers: [ticketAnswer({ provider: 'stream' })] });
    expect((await mixed1.adapter.video.createUpload(INSPECTION, {})).ok).toBe(false);
    const mixed2 = await setup({ answers: [ticketAnswer({ ref: { provider: 'stream', streamUid: 'abcdefgh1234' } })] });
    expect((await mixed2.adapter.video.createUpload(INSPECTION, {})).ok).toBe(false);
    const good = await setup({ answers: [ticketAnswer()] });
    expect((await good.adapter.video.createUpload(INSPECTION, {})).ok).toBe(true);
  });

  it('a clip on the device never sends a poster, even when the connection has come back; control: an engine ticket does', async () => {
    const s = await setup({ online: false, answers: [reply(200, { data: { posterKey: 'p' } })] });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    s.state.online = true;
    expect((await s.adapter.video.uploadPoster(INSPECTION, ticket, new Blob(['p']))).ok).toBe(false);
    expect(s.api.calls).toEqual([]);
    const engine = await setup({ answers: [ticketAnswer(), reply(200, { data: { posterKey: 'p' } })] });
    const real = need((await engine.adapter.video.createUpload(INSPECTION, {})).data);
    expect((await engine.adapter.video.uploadPoster(INSPECTION, real, new Blob(['p']))).ok).toBe(true);
  });

  it('the clip upload has a long timeout: it is not a photo', async () => {
    const s = await setup({ answers: [ticketAnswer(), reply(200, { data: { mediaId: 'm1', r2Key: R2_KEY } })] });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    expect(s.api.calls[1]?.timeoutMs).toBe(600_000);
  });

  it('a Stream poster pick for a clip that is still on the device sends nothing and says so', async () => {
    const s = await setup({ online: true, provider: 'stream' });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    const uid = ticket.ref.provider === 'stream' ? ticket.ref.streamUid : '';
    expect(await s.adapter.video.setPoster(INSPECTION, { streamUid: uid, posterPct: 0.5 })).toEqual({ ok: false, error: MESSAGES.posterNotSaved });
    expect(s.api.calls).toEqual([]);
  });

  it('once finalized, a clip is no longer a local one (the map does not grow)', async () => {
    const s = await setup({ online: false, answers: [reply(200, { data: { poolId: 'pool-1' } })] });
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    const input = { provider: 'r2', mediaId: 'local-id1', r2Key: 'local/local-id1.mp4' } as const;
    expect((await s.adapter.video.finalize(INSPECTION, input)).data).toEqual({ poolId: '' });
    expect(s.api.calls).toEqual([]);
    // A second finalize of the same id is not answered locally any more: it goes to the engine.
    await s.adapter.video.finalize(INSPECTION, input);
    expect(s.api.calls).toHaveLength(1);
  });
});

describe('the poster picker and removal', () => {
  it('picking a Stream poster needs a connection, and online posts the percentage', async () => {
    const off = await setup({ online: false });
    expect(await off.adapter.video.setPoster(INSPECTION, { streamUid: 'abcdefgh1234', posterPct: 0.5 })).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(off.api.calls).toEqual([]);
    const on = await setup({ answers: [reply(200, {}), reply(500)] });
    expect(await on.adapter.video.setPoster(INSPECTION, { streamUid: 'abcdefgh1234', posterPct: 0.5 })).toEqual({ ok: true });
    expect(on.api.calls[0]).toMatchObject({ method: 'POST', path: `/api/inspections/${INSPECTION}/media/video/poster`, json: { streamUid: 'abcdefgh1234', posterPct: 0.5 } });
    expect(await on.adapter.video.setPoster(INSPECTION, { streamUid: 'abcdefgh1234', posterPct: 0.5 })).toEqual({ ok: false, error: MESSAGES.posterNotSaved });
  });

  it('removal says it is not available instead of doing nothing', async () => {
    const s = await setup();
    expect(await s.adapter.video.remove(INSPECTION, 'abcdefgh1234')).toEqual({ ok: false, error: MESSAGES.videoRemovalUnavailable });
    expect(s.api.calls).toEqual([]);
  });
});

describe('resolveVideo: the document step of the reconciler', () => {
  async function storedRow(s: Awaited<ReturnType<typeof setup>>, state: 'pending' | 'uploading' | 'uploaded', uploadedKey: string | null) {
    const ticket = need((await s.adapter.video.createUpload(INSPECTION, {})).data);
    await s.adapter.video.uploadFile(ticket, clip(), () => undefined);
    if (state !== 'pending') await s.world.store.markState('local-id1', state, { attempts: 0, ...(uploadedKey === null ? {} : { uploadedKey }) });
  }

  it('resolves a clip whose upload and finalize are done (its row holds the key the server stored it under)', async () => {
    const s = await setup({ online: false });
    await storedRow(s, 'uploaded', R2_KEY.replace('m1', 'local-id1'));
    expect(await s.adapter.resolveVideo(INSPECTION, 'local-id1', { provider: 'r2', mediaId: 'local-id1', r2Key: R2_KEY.replace('m1', 'local-id1') })).toBe('resolved');
  });

  it('keeps the file (missing) unless the row is `uploaded` with the key of this reference, in this inspection', async () => {
    const key = R2_KEY.replace('m1', 'local-id1');
    const refFor = { provider: 'r2', mediaId: 'local-id1', r2Key: key } as const;
    // `uploading` carries the key BEFORE the server finalizes: a caller in that window must not make the file go.
    for (const state of ['pending', 'uploading'] as const) {
      const s = await setup({ online: false });
      await storedRow(s, state, key);
      expect(await s.adapter.resolveVideo(INSPECTION, 'local-id1', refFor), state).toBe('missing');
    }
    const failed = await setup({ online: false });
    await storedRow(failed, 'uploaded', key);
    await failed.world.store.markState('local-id1', 'failed', { attempts: 3 });
    expect(await failed.adapter.resolveVideo(INSPECTION, 'local-id1', refFor)).toBe('missing');
    const otherKey = await setup({ online: false });
    await storedRow(otherKey, 'uploaded', key);
    expect(await otherKey.adapter.resolveVideo(INSPECTION, 'local-id1', { provider: 'r2', mediaId: 'other', r2Key: R2_KEY.replace('m1', 'other') })).toBe('missing');
    const otherInspection = await setup({ online: false });
    await storedRow(otherInspection, 'uploaded', key);
    expect(await otherInspection.adapter.resolveVideo('insp-other', 'local-id1', refFor)).toBe('missing');
    const gone = await setup({ online: false });
    expect(await gone.adapter.resolveVideo(INSPECTION, 'local-id1', refFor)).toBe('missing');
    // Control: uploaded, same key, same inspection.
    const done = await setup({ online: false });
    await storedRow(done, 'uploaded', key);
    expect(await done.adapter.resolveVideo(INSPECTION, 'local-id1', refFor)).toBe('resolved');
  });

  it('a Stream clip is matched by its uid', async () => {
    const s = await setup({ online: false, provider: 'stream' });
    await storedRow(s, 'uploaded', 'stream/abcdefgh1234');
    expect(await s.adapter.resolveVideo(INSPECTION, 'local-id1', { provider: 'stream', streamUid: 'abcdefgh1234' })).toBe('resolved');
    expect(await s.adapter.resolveVideo(INSPECTION, 'local-id1', { provider: 'stream', streamUid: 'zzzzzzzz9999' })).toBe('missing');
  });

  it('a blocked inspection is refused with the block error, so the reconciler leaves the row alone', async () => {
    const s = await setup({ online: false });
    await storedRow(s, 'uploaded', R2_KEY.replace('m1', 'local-id1'));
    s.state.blocked = true;
    const attempt = s.adapter.resolveVideo(INSPECTION, 'local-id1', { provider: 'r2', mediaId: 'local-id1', r2Key: R2_KEY.replace('m1', 'local-id1') });
    await expect(attempt).rejects.toSatisfy((error) => isMediaError(error) && error.code === 'BLOCKED');
  });
});

