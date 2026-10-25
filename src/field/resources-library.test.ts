import { describe, expect, it } from 'vitest';
import type { CostItemView } from '@inspectorhub/field-ui';
import { MESSAGES } from './messages';
import { createCommentsLibrary, createCostItems, createPrefs, createRepairItems, DEFAULT_INSPECTION_PREFS } from './resources-library';
import { cacheRow, resourceWorld } from './test-support/resource-world';
import { reply } from './test-support/scripted-api';
import { envelope, seedPackage } from './test-support/seed-package';

const entry = { text: '  Replace the flashing.  ', severity: 'significant', section: '', category: 'Roof', itemLabel: '', repairSummary: 'Replace', recommendedContractorTypeId: '' };

describe('prefs', () => {
  it('online: reads the tenant preferences over the defaults and remembers them for when the connection is gone', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off', pinnedTagIds: ['t1'] })] });
    const prefs = createPrefs(w.deps);
    expect(await prefs.load()).toEqual({ ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'off', pinnedTagIds: ['t1'] });
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/tenant/inspection-prefs' });
    w.state.online = false;
    expect((await prefs.load()).autoAdvance).toBe('off');
    expect(w.api.calls).toHaveLength(1);
  });

  it('never read: offline and a failed read both answer the defaults', async () => {
    const off = await resourceWorld({ online: false });
    expect(await createPrefs(off.deps).load()).toEqual(DEFAULT_INSPECTION_PREFS);
    expect(off.api.calls).toHaveLength(0);
    const failed = await resourceWorld({ answers: [reply(500)] });
    expect(await createPrefs(failed.deps).load()).toEqual(DEFAULT_INSPECTION_PREFS);
  });

  it('patch: sends the delta and adopts the merged answer; offline and refusals say why', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'keyboard' }), reply(403), reply(500), { kind: 'problem', problem: 'unknown' }] });
    const prefs = createPrefs(w.deps);
    expect(await prefs.patch({ autoAdvance: 'keyboard' })).toEqual({ ok: true, data: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'keyboard' } });
    expect(w.api.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/tenant/inspection-prefs', json: { autoAdvance: 'keyboard' } });
    expect(await prefs.patch({ agentRepairAccess: 'off' })).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(await prefs.patch({ autoAdvance: 'off' })).toEqual({ ok: false, error: MESSAGES.prefsNotSaved });
    expect(await prefs.patch({ autoAdvance: 'off' })).toEqual({ ok: false, error: MESSAGES.outcomeUnknown });
    w.state.online = false;
    const before = w.api.calls.length;
    expect(await prefs.patch({ autoAdvance: 'off' })).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(w.api.calls).toHaveLength(before);
  });
});

describe('prefs: what the server says is checked', () => {
  it('a field of the wrong type or with an unknown value is ignored; a good one is taken', async () => {
    const w = await resourceWorld({
      answers: [reply(200, { autoAdvance: 'sideways', autoAdvanceDelayMs: 'fast', pinnedTagIds: [1, 2], cloneDefault: 'all', requireDefectFields: 'both', agentRepairAccess: 7, reportLinkTtl: { count: 3, unit: 'weeks' }, extra: 'x' })],
    });
    const prefs = await createPrefs(w.deps).load();
    expect(prefs).toEqual({ ...DEFAULT_INSPECTION_PREFS, cloneDefault: 'all', requireDefectFields: 'both' });
    expect(prefs).not.toHaveProperty('extra');
  });

  it('a good time-to-live and a good tag list are taken', async () => {
    const w = await resourceWorld({ answers: [reply(200, { reportLinkTtl: { count: 3, unit: 'months' }, pinnedTagIds: ['a'], autoAdvanceDelayMs: 500 })] });
    expect(await createPrefs(w.deps).load()).toMatchObject({ reportLinkTtl: { count: 3, unit: 'months' }, pinnedTagIds: ['a'], autoAdvanceDelayMs: 500 });
  });

  it('never hands out the shared defaults: changing an answer changes nothing for the next reader', async () => {
    const off = await resourceWorld({ online: false });
    const prefs = createPrefs(off.deps);
    const first = await prefs.load();
    expect(first).not.toBe(DEFAULT_INSPECTION_PREFS);
    first.pinnedTagIds.push('x');
    first.autoAdvance = 'off';
    expect(await prefs.load()).toEqual(DEFAULT_INSPECTION_PREFS);
    expect(DEFAULT_INSPECTION_PREFS.pinnedTagIds).toEqual([]);
  });
});

describe('comments library', () => {
  it('list: sends only the filters that have a value, in the order they were set, and reads the rows', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: [{ id: 'c1', text: 'Seal the joint', category: 'Roof', severity: 'minor', section: null, useCount: 2 }, { nope: 1 }] })] });
    const rows = await createCommentsLibrary(w.deps).list({ sort: 'relevance', search: 'seal', section: '', severity: undefined });
    expect(rows).toEqual([{ id: 'c1', text: 'Seal the joint', category: 'Roof', severity: 'minor', section: null, useCount: 2 }]);
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/admin/comments' });
    expect(Object.entries(w.api.calls[0]?.query ?? {})).toEqual([['sort', 'relevance'], ['search', 'seal']]);
  });

  it('list: offline and a failed read answer an empty list', async () => {
    const off = await resourceWorld({ online: false });
    expect(await createCommentsLibrary(off.deps).list()).toEqual([]);
    expect(off.api.calls).toHaveLength(0);
    const failed = await resourceWorld({ answers: [reply(500)] });
    expect(await createCommentsLibrary(failed.deps).list()).toEqual([]);
    const noQuery = await resourceWorld({ answers: [reply(200, { data: [] })] });
    await createCommentsLibrary(noQuery.deps).list();
    expect(noQuery.api.calls[0]?.query).toBeUndefined();
  });

  it('save and edit: the body is trimmed, an empty field is none, an unknown severity is none', async () => {
    const w = await resourceWorld({ answers: [reply(200), reply(200)] });
    const lib = createCommentsLibrary(w.deps);
    expect(await lib.save(entry)).toEqual({ ok: true });
    expect(await lib.edit('c 1', { ...entry, severity: 'all' })).toEqual({ ok: true });
    expect(w.api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/admin/comments',
      json: { text: 'Replace the flashing.', severity: 'significant', section: null, category: 'Roof', itemLabel: null, repairSummary: 'Replace', recommendedContractorTypeId: null },
    });
    expect(w.api.calls[1]).toMatchObject({ method: 'PUT', path: '/api/admin/comments/c%201' });
    expect((w.api.calls[1]?.json as { severity: unknown }).severity).toBeNull();
  });

  it('touch posts to the usage route of the comment', async () => {
    const w = await resourceWorld({ answers: [reply(200)] });
    expect(await createCommentsLibrary(w.deps).touch('c1')).toEqual({ ok: true });
    expect(w.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/admin/comments/c1/touch' });
  });

  it('writes: an empty comment, a bad id, offline and a refusal each answer a sentence; only the empty comment and the bad id send nothing', async () => {
    const w = await resourceWorld({ answers: [reply(500)] });
    const lib = createCommentsLibrary(w.deps);
    expect(await lib.save({ ...entry, text: '   ' })).toEqual({ ok: false, error: MESSAGES.commentNotSaved });
    expect(await lib.touch('../x')).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await lib.edit('..', entry)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(w.api.calls).toHaveLength(0);
    expect(await lib.save(entry)).toEqual({ ok: false, error: MESSAGES.commentNotSaved });
    expect(w.api.calls).toHaveLength(1);
    w.state.online = false;
    expect(await lib.save(entry)).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(await lib.touch('c1')).toEqual({ ok: false, error: MESSAGES.needsConnection });
    expect(w.api.calls).toHaveLength(1);
  });
});

describe('repair items', () => {
  const recs = [{ id: 'r1', name: 'Reseal', category: 'Roof', defaultRepairSummary: 'Reseal it', recommendedContractorTypeId: 'ct1' }, { id: 'r2', name: 'Paint', category: null, defaultRepairSummary: '', recommendedContractorTypeId: null }];
  const types = [{ id: 'ct1', name: 'Roofer' }];
  const expected = [
    { id: 'r1', name: 'Reseal', category: 'Roof', defaultRepairSummary: 'Reseal it', contractorTypeName: 'Roofer' },
    { id: 'r2', name: 'Paint', category: null, defaultRepairSummary: '', contractorTypeName: null },
  ];

  it('online: joins the catalogue with the contractor names', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: recs }), reply(200, { data: types })] });
    expect(await createRepairItems(w.deps).list()).toEqual(expected);
    expect(w.api.calls.map((call) => call.path).sort()).toEqual(['/api/contractor-types', '/api/recommendations']);
  });

  it('online without the contractor names still lists the catalogue', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: recs }), reply(500)] });
    expect((await createRepairItems(w.deps).list()).map((item) => item.contractorTypeName)).toEqual([null, null]);
  });

  it('offline, or when the read fails, it is the copy on the device', async () => {
    const off = await resourceWorld({ online: false });
    await cacheRow(off.db, '/api/recommendations', recs);
    await cacheRow(off.db, '/api/contractor-types', types);
    expect(await createRepairItems(off.deps).list()).toEqual(expected);
    expect(off.api.calls).toHaveLength(0);
    const failed = await resourceWorld({ answers: [reply(500), reply(500)] });
    await cacheRow(failed.db, '/api/recommendations', recs);
    expect((await createRepairItems(failed.deps).list()).map((item) => item.id)).toEqual(['r1', 'r2']);
  });

  it('nothing on the device and no connection is an empty list, not an error', async () => {
    const off = await resourceWorld({ online: false });
    expect(await createRepairItems(off.deps).list()).toEqual([]);
  });
});

describe('cost items', () => {
  const line = (id: string): CostItemView => ({
    id, system: 'Roof', component: 'Shingles', location: '', action: 'replace', costMethod: 'lump_sum', quantity: null, uom: null, unitCostCents: null, lumpSumCents: 120_000, eul: 20, effAge: null, rul: null, suggestedRemedy: '', bucket: 'short_term', sectionRef: null, photoRef: null, sortOrder: 1,
  });

  it('list online: the lines and the reserve switch', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: [line('c1')], reserveEnabled: true })] });
    expect(await createCostItems(w.deps).list('i1')).toEqual({ items: [line('c1')], reserveEnabled: true });
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/inspections/i1/cost-items' });
  });

  it('list offline or after a failed read: the copy on the device, else nothing', async () => {
    const off = await resourceWorld({ online: false });
    await seedPackage(off.db, 'i1', { bodies: { '/api/inspections/i1/cost-items': envelope([line('cached')]) } });
    expect((await createCostItems(off.deps).list('i1')).items.map((item) => item.id)).toEqual(['cached']);
    expect(await createCostItems(off.deps).list('i2')).toEqual({ items: [], reserveEnabled: false });
    expect(off.api.calls).toHaveLength(0);
    const failed = await resourceWorld({ answers: [reply(500)] });
    await seedPackage(failed.db, 'i1', { bodies: { '/api/inspections/i1/cost-items': envelope([line('cached')]) } });
    expect((await createCostItems(failed.deps).list('i1')).items).toHaveLength(1);
  });

  it('a blocked inspection lists nothing and is not asked', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: [line('c1')] })] });
    w.state.blocked.add('i1');
    expect(await createCostItems(w.deps).list('i1')).toEqual({ items: [], reserveEnabled: false });
    expect(w.api.calls).toHaveLength(0);
    w.state.blocked.clear();
    expect((await createCostItems(w.deps).list('i1')).items).toHaveLength(1);
  });

  it('save: create, update and delete are the engine routes; a created line answers its id; the cache is refreshed after each', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: { id: 'new-1' } }), reply(200, {}), reply(200, {})] });
    const costs = createCostItems(w.deps);
    expect(await costs.save('i1', { intent: 'create', item: line('draft') })).toEqual({ ok: true, data: { id: 'new-1' } });
    expect(await costs.save('i1', { intent: 'update', item: line('c1') })).toEqual({ ok: true, data: {} });
    expect(await costs.save('i1', { intent: 'delete', itemId: 'c1' })).toEqual({ ok: true, data: {} });
    expect(w.api.calls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/api/inspections/i1/cost-items'],
      ['PATCH', '/api/inspections/i1/cost-items/c1'],
      ['DELETE', '/api/inspections/i1/cost-items/c1'],
    ]);
    const body = w.api.calls[0]?.json as Record<string, unknown>;
    expect(body).toMatchObject({ system: 'Roof', component: 'Shingles', action: 'replace', costMethod: 'lump_sum', quantity: null, lumpSumCents: 120_000, eul: 20, bucket: 'short_term', sortOrder: 1 });
    expect(body).not.toHaveProperty('location');
    expect(w.refreshed).toEqual(['i1', 'i1', 'i1']);
  });

  it('save: a refusal does not refresh the cache; offline and blocked send nothing', async () => {
    const w = await resourceWorld({ answers: [reply(403)] });
    const costs = createCostItems(w.deps);
    expect(await costs.save('i1', { intent: 'delete', itemId: 'c1' })).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(w.refreshed).toEqual([]);
    w.state.online = false;
    expect(await costs.save('i1', { intent: 'delete', itemId: 'c1' })).toEqual({ ok: false, error: MESSAGES.needsConnection });
    w.state.online = true;
    w.state.blocked.add('i1');
    expect(await costs.save('i1', { intent: 'delete', itemId: 'c1' })).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(await costs.save('i1', { intent: 'delete', itemId: '..' })).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(w.api.calls).toHaveLength(1);
  });

  it('save: an item id that cannot be a path segment is refused without a request', async () => {
    const w = await resourceWorld();
    expect(await createCostItems(w.deps).save('i1', { intent: 'delete', itemId: '../x' })).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(w.api.calls).toHaveLength(0);
  });
});
