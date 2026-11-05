import { afterEach, describe, expect, it } from 'vitest';
import { scenarios, startRendererEngine, type RendererEngine } from './engine';

/** The published-report scenario: what the engine does with a report that went out, as the app's emulator flows rely on it. */
const AUTH = { authorization: 'Bearer renderer-access-token', 'content-type': 'application/json' };
let engine: RendererEngine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
});

const post = (path: string, body: unknown = {}) => fetch(`${engine!.url}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
const detail = async () => ((await (await fetch(`${engine!.url}/api/inspections/insp-7`, { headers: AUTH })).json()) as { data: Record<string, unknown> }).data;

describe('the published scenario', () => {
  it('starts as a report published as version 3 and locked, which the inspection answer says', async () => {
    engine = await startRendererEngine(scenarios.published);
    expect(engine.report).toEqual({ state: 'locked', version: 3 });
    expect(await detail()).toMatchObject({ publishedVersionNumber: 3, editingAgain: false, contentLocked: true, inspection: { reportStatus: 'published' } });
  });

  it('edit-again opens it: editing, not locked, clients still on version 3; repeating it answers the same', async () => {
    engine = await startRendererEngine(scenarios.published);
    const first = await post('/api/inspections/insp-7/edit-again');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, data: { state: 'editing' } });
    expect((await post('/api/inspections/insp-7/edit-again')).status).toBe(200);
    expect(await detail()).toMatchObject({ publishedVersionNumber: 3, editingAgain: true, contentLocked: false });
    expect(engine.reopens).toBe(2);
  });

  it('a publish with nothing said is "nothing changed since version 3": no new version, the notice choice is recorded, and it locks again', async () => {
    engine = await startRendererEngine(scenarios.published);
    await post('/api/inspections/insp-7/edit-again');
    const res = await post('/api/inspections/insp-7/publish', { notifyClient: false });
    expect((await res.json()) as { data: unknown }).toMatchObject({ data: { reportStatus: 'published', unchangedSinceVersion: 3 } });
    expect(engine.publishes).toEqual([{ notifyClient: false, summary: null, outcome: 'unchanged' }]);
    expect(engine.report).toEqual({ state: 'locked', version: 3 });
  });

  it('a publish with a summary makes version 4, records the notice choice the app sent, and locks again', async () => {
    engine = await startRendererEngine(scenarios.published);
    await post('/api/inspections/insp-7/edit-again');
    const res = await post('/api/inspections/insp-7/publish', { summary: ' Corrected the roof rating ', notifyClient: true });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('unchangedSinceVersion');
    expect(engine.publishes).toEqual([{ notifyClient: true, summary: 'Corrected the roof rating', outcome: 'new_version' }]);
    expect(engine.report).toEqual({ state: 'locked', version: 4 });
    expect(await detail()).toMatchObject({ publishedVersionNumber: 4, contentLocked: true });
  });

  it('the work list row carries the version and the editing state', async () => {
    engine = await startRendererEngine(scenarios.published);
    const list = (await (await fetch(`${engine.url}/api/inspections`, { headers: AUTH })).json()) as { data: Array<Record<string, unknown>> };
    expect(list.data[0]).toMatchObject({ id: 'insp-7', publishedVersionNumber: 3, editingAgain: false });
  });

  it('control: an unpublished inspection is a draft, refuses edit-again, and has no version', async () => {
    engine = await startRendererEngine(scenarios.inspection);
    expect(engine.report).toEqual({ state: 'draft', version: null });
    expect(await detail()).toMatchObject({ publishedVersionNumber: null, editingAgain: false, contentLocked: false, inspection: { reportStatus: 'in_progress' } });
    const refused = await post('/api/inspections/insp-7/edit-again');
    expect(refused.status).toBe(400);
    expect(engine.reopens).toBe(0);
  });
});
