import { describe, expect, it } from 'vitest';
import { MESSAGES } from './messages';
import { reopenReport } from './reopen-report';
import { reply, scriptedApi } from './test-support/scripted-api';


function setup(online: boolean, answer: ReturnType<typeof reply> | undefined, cacheCurrent = true) {
  const api = scriptedApi(...(answer === undefined ? [] : [answer]));
  const after = { calls: [] as string[] };
  return {
    api,
    after,
    run: () => reopenReport({ api, isOnline: () => online, afterWrite: (id) => { after.calls.push(id); return Promise.resolve(cacheCurrent); } }, 'i1'),
  };
}

describe('reopen a published report ("Edit and republish")', () => {
  it('asks the server, then refreshes that inspection, and reports the cache as current', async () => {
    const t = setup(true, reply(200, { success: true, data: { reportId: 'r1', state: 'editing' } }));
    expect(await t.run()).toEqual({ ok: true, cacheCurrent: true });
    expect(t.api.calls).toHaveLength(1);
    expect(t.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/edit-again' });
    expect(t.after.calls).toEqual(['i1']);
  });

  it('says so when the server opened the report but this device could not download the new state', async () => {
    const t = setup(true, reply(200, { success: true, data: { reportId: 'r1', state: 'editing' } }), false);
    expect(await t.run()).toEqual({ ok: true, cacheCurrent: false });
  });

  it('offline: nothing is sent and the connection sentence is shown', async () => {
    const t = setup(false, undefined);
    expect(await t.run()).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(t.api.calls).toHaveLength(0);
    expect(t.after.calls).toEqual([]);
  });

  it('a refusal shows the server sentence and refreshes nothing', async () => {
    const t = setup(true, reply(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Only a published report can be edited again.' } }));
    expect(await t.run()).toEqual({ ok: false, error: 'Only a published report can be edited again.' });
    expect(t.after.calls).toEqual([]);
  });

  it('a refusal for lack of permission says so, and an answer with no sentence falls back to the generic one', async () => {
    expect(await setup(true, reply(403, {})).run()).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(await setup(true, reply(500, {})).run()).toEqual({ ok: false, error: MESSAGES.reopenFailed });
  });

  it('a lost connection mid-request is reported as a failure that can be retried (the call is repeatable)', async () => {
    const t = setup(true, { kind: 'problem', problem: 'unknown' } as never);
    const out = await t.run();
    expect(out.ok).toBe(false);
    expect(t.after.calls).toEqual([]);
  });
});

