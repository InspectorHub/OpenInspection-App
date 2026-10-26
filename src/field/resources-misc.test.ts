import { describe, expect, it } from 'vitest';
import { MESSAGES } from './messages';
import { createAiAssist, createPublishReadiness, createVersionHistory } from './resources-misc';
import { resourceWorld } from './test-support/resource-world';
import { reply } from './test-support/scripted-api';

describe('publish readiness', () => {
  const verdict = { ready: false, blockingDefects: [{ sectionId: 's', itemId: 'i', itemLabel: 'Roof' }], warningDefects: [] };

  it('answers the engine verdict as it is', async () => {
    const w = await resourceWorld({ answers: [reply(200, verdict)] });
    expect(await createPublishReadiness(w.deps).check('i1')).toEqual(verdict);
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/inspections/i1/publish-readiness' });
  });

  it('cannot be made: null, so the editor goes on to the publish dialog (offline, blocked, refused, unreadable)', async () => {
    const off = await resourceWorld({ online: false });
    expect(await createPublishReadiness(off.deps).check('i1')).toBeNull();
    expect(off.api.calls).toHaveLength(0);
    const blocked = await resourceWorld({ answers: [reply(200, verdict)] });
    blocked.state.blocked.add('i1');
    expect(await createPublishReadiness(blocked.deps).check('i1')).toBeNull();
    expect(blocked.api.calls).toHaveLength(0);
    const refused = await resourceWorld({ answers: [reply(500)] });
    expect(await createPublishReadiness(refused.deps).check('i1')).toBeNull();
    const odd = await resourceWorld({ answers: [reply(200, { ready: 'yes' })] });
    expect(await createPublishReadiness(odd.deps).check('i1')).toBeNull();
  });
});

describe('version history', () => {
  it('list reads the snapshot entries and drops what is not one', async () => {
    const w = await resourceWorld({ answers: [reply(200, [{ seq: 3, atMs: 10, byUserId: 'u1', reason: 'manual' }, { seq: 2, atMs: 9, byUserId: null, reason: 'weird' }, { nope: 1 }])] });
    expect(await createVersionHistory(w.deps).list('i1')).toEqual({ ok: true, data: [{ seq: 3, atMs: 10, byUserId: 'u1', reason: 'manual' }, { seq: 2, atMs: 9, byUserId: null }] });
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/inspections/i1/collab/snapshots' });
  });

  it('get reads one version projection; a missing projection is not ok', async () => {
    const w = await resourceWorld({ answers: [reply(200, { projection: { 'k:s:i': { rating: 'good' } } }), reply(200, {})] });
    const history = createVersionHistory(w.deps);
    expect(await history.get('i1', 3)).toEqual({ ok: true, data: { projection: { 'k:s:i': { rating: 'good' } } } });
    expect(w.api.calls[0]?.path).toBe('/api/inspections/i1/collab/snapshots/3');
    expect((await history.get('i1', 4)).ok).toBe(false);
    expect((await history.get('i1', -1)).error).toBe(MESSAGES.invalidValue);
    expect((await history.get('i1', 1.5)).error).toBe(MESSAGES.invalidValue);
  });

  it('restore and capture post to the collab routes; a refusal carries the server sentence when it wrote one', async () => {
    const w = await resourceWorld({ answers: [reply(200), reply(409, { error: 'That version is gone.' }), reply(500), reply(200)] });
    const history = createVersionHistory(w.deps);
    expect(await history.restore('i1', 2)).toEqual({ ok: true });
    expect(w.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/collab/restore', json: { seq: 2 } });
    expect(await history.restore('i1', 2)).toEqual({ ok: false, error: 'That version is gone.' });
    expect(await history.capture('i1')).toEqual({ ok: false, error: MESSAGES.requestFailed });
    expect(await history.capture('i1')).toEqual({ ok: true });
    expect(w.api.calls[3]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/collab/snapshots' });
  });

  it('restore and capture check what they are given before any request', async () => {
    const w = await resourceWorld();
    const history = createVersionHistory(w.deps);
    for (const seq of [-1, 1.5, Number.NaN]) expect(await history.restore('i1', seq), String(seq)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await history.restore('../x', 1)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await history.capture('..')).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(w.api.calls).toHaveLength(0);
  });

  it('offline and blocked: every member answers a sentence and sends nothing', async () => {
    const w = await resourceWorld({ online: false });
    const history = createVersionHistory(w.deps);
    for (const result of [await history.list('i1'), await history.get('i1', 1), await history.restore('i1', 1), await history.capture('i1')]) {
      expect(result).toEqual({ ok: false, error: MESSAGES.needsConnection });
    }
    w.state.online = true;
    w.state.blocked.add('i1');
    expect(await history.capture('i1')).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(w.api.calls).toHaveLength(0);
  });
});

describe('AI assist', () => {
  it('assist sends the trimmed text and context and needs both the text and the call id back', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: { text: 'Better words', aiCallId: 'call-1' } }), reply(200, { data: { text: 'No id' } })] });
    const ai = createAiAssist(w.deps);
    expect(await ai.run({ intent: 'assist', payload: { text: '  rough note ', context: ' Roof ' } })).toEqual({ ok: true, intent: 'assist', text: 'Better words', aiCallId: 'call-1' });
    expect(w.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/ai/comment-assist', json: { text: 'rough note', context: 'Roof' } });
    expect(await ai.run({ intent: 'assist', payload: { text: 'again' } })).toEqual({ ok: false, error: MESSAGES.aiUnavailable });
    expect(w.api.calls[1]?.json).toEqual({ text: 'again' });
  });

  it('review records the person who read the output, and only a success answer counts', async () => {
    const w = await resourceWorld({ answers: [reply(200), reply(500, { error: { message: 'Review refused.' } })] });
    const ai = createAiAssist(w.deps);
    expect(await ai.run({ intent: 'review', payload: { artifactId: 'a1', aiCallId: 'call-1' } })).toEqual({ ok: true, intent: 'review' });
    expect(w.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/ai/reviews', json: { artifactType: 'inspection_result', artifactId: 'a1', aiCallId: 'call-1' } });
    expect(await ai.run({ intent: 'review', payload: { artifactId: 'a1', aiCallId: 'call-1' } })).toEqual({ ok: false, error: 'Review refused.' });
  });

  it('an empty text or ids send nothing; offline says it needs a connection; an unreachable server is a sentence', async () => {
    const w = await resourceWorld({ answers: [{ kind: 'problem', problem: 'unknown' }] });
    const ai = createAiAssist(w.deps);
    expect(await ai.run({ intent: 'assist', payload: { text: '   ' } })).toEqual({ ok: false, error: MESSAGES.aiUnavailable });
    expect(await ai.run({ intent: 'review', payload: { artifactId: '', aiCallId: 'c' } })).toEqual({ ok: false, error: MESSAGES.aiUnavailable });
    expect(w.api.calls).toHaveLength(0);
    expect(await ai.run({ intent: 'assist', payload: { text: 'x' } })).toEqual({ ok: false, error: MESSAGES.outcomeUnknown });
    w.state.online = false;
    expect(await ai.run({ intent: 'assist', payload: { text: 'x' } })).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(w.api.calls).toHaveLength(1);
  });
});
