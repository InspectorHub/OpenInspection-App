import { describe, expect, it } from 'vitest';
import { createMediaPool, createSettingsSheet, createTemplateSearch } from './resources-media';
import { resourceWorld } from './test-support/resource-world';
import { reply } from './test-support/scripted-api';

const media = {
  data: {
    attached: [
      { key: 't/inspections/i1/photos/a.jpg', url: 'https://server/a', itemLabel: 'Roof cover', itemId: 'itm1', photoIndex: 0, annotated: true, originalKey: 't/inspections/i1/photos/a0.jpg' },
      { key: 't/inspections/i1/photos/a.jpg', url: 'dup' },
      { key: '', url: 'empty-key' },
    ],
    pool: [{ key: 't/inspections/i1/photos/loose.jpg', url: 'https://server/l' }, { key: 't/inspections/i1/photos/a.jpg', url: 'dup-of-attached' }],
  },
};

describe('media pool', () => {
  it('lists the attached and loose photos once each, addressed through urls.photo and never the server url', async () => {
    const w = await resourceWorld({ answers: [reply(200, media)] });
    const listing = await createMediaPool(w.deps).list('i1');
    expect(listing).toEqual({
      answered: true,
      photos: [
        { key: 't/inspections/i1/photos/a.jpg', url: 'local://i1/t/inspections/i1/photos/a.jpg', label: 'Roof cover', itemId: 'itm1', photoIndex: 0, annotated: true, originalKey: 't/inspections/i1/photos/a0.jpg' },
        { key: 't/inspections/i1/photos/loose.jpg', url: 'local://i1/t/inspections/i1/photos/loose.jpg', label: 'Unattached' },
      ],
    });
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/inspections/i1/media' });
    expect(JSON.stringify(listing)).not.toContain('https://server');
  });

  it('an inspection with no photos is answered (empty); no answer is not', async () => {
    const empty = await resourceWorld({ answers: [reply(200, { data: { attached: [], pool: [] } })] });
    expect(await createMediaPool(empty.deps).list('i1')).toEqual({ photos: [], answered: true });
    const failed = await resourceWorld({ answers: [reply(500)] });
    expect(await createMediaPool(failed.deps).list('i1')).toEqual({ photos: [], answered: false });
  });

  it('offline and blocked: not answered, nothing sent', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(200, media)] });
    expect(await createMediaPool(w.deps).list('i1')).toEqual({ photos: [], answered: false });
    w.state.online = true;
    w.state.blocked.add('i1');
    expect(await createMediaPool(w.deps).list('i1')).toEqual({ photos: [], answered: false });
    expect(w.api.calls).toHaveLength(0);
    w.state.blocked.clear();
    expect((await createMediaPool(w.deps).list('i1')).answered).toBe(true);
  });
});

describe('settings sheet', () => {
  const inspection = { data: { inspection: { id: 'i1', templateId: 't1', propertyType: 'single_family' } } };
  const templates = { data: [{ id: 't1', name: 'Standard' }, { id: '', name: 'bad' }], meta: { page: 1, totalPages: 1 } };

  it('bundles the inspection row, the templates, the cover photos and the appearance profiles', async () => {
    const w = await resourceWorld({ answers: [reply(200, inspection), reply(200, templates), reply(200, media)] });
    const sheet = await createSettingsSheet(w.deps).load('i1');
    expect(sheet?.inspection).toEqual({ id: 'i1', templateId: 't1', propertyType: 'single_family' });
    expect(sheet?.templates).toEqual([{ id: 't1', name: 'Standard' }]);
    expect(sheet?.photos.map((photo) => photo.url)).toEqual(['local://i1/t/inspections/i1/photos/a.jpg', 'local://i1/t/inspections/i1/photos/loose.jpg']);
    expect(sheet?.profiles.map((profile) => profile.id)).toEqual(['signature', 'meridian', 'terra']);
    const templateCall = w.api.calls.find((call) => call.path === '/api/inspections/templates');
    expect(templateCall?.query).toEqual({ page: '1', pageSize: '100' });
  });

  it('without the inspection row it is null, so the sheet offers a retry and not a form that saves blanks', async () => {
    const w = await resourceWorld({ answers: [reply(500), reply(200, templates), reply(200, media)] });
    expect(await createSettingsSheet(w.deps).load('i1')).toBeNull();
  });

  it('templates or photos that cannot be read leave the rest of the sheet usable', async () => {
    const w = await resourceWorld({ answers: [reply(200, inspection), reply(500), reply(500)] });
    const sheet = await createSettingsSheet(w.deps).load('i1');
    expect(sheet?.inspection).not.toBeNull();
    expect(sheet?.templates).toEqual([]);
    expect(sheet?.photos).toEqual([]);
  });

  it('offline and blocked: null, nothing sent', async () => {
    const w = await resourceWorld({ online: false });
    expect(await createSettingsSheet(w.deps).load('i1')).toBeNull();
    w.state.online = true;
    w.state.blocked.add('i1');
    expect(await createSettingsSheet(w.deps).load('i1')).toBeNull();
    expect(w.api.calls).toHaveLength(0);
  });
});

describe('template search', () => {
  it('asks for a page of 25 with the search text and answers whether more pages follow', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: [{ id: 't1', name: 'Standard' }], meta: { page: 2, totalPages: 3 } })] });
    expect(await createTemplateSearch(w.deps).search({ q: 'stan', page: 2 })).toEqual({ templates: [{ id: 't1', name: 'Standard' }], hasMore: true, page: 2, totalPages: 3 });
    expect(w.api.calls[0]).toMatchObject({ method: 'GET', path: '/api/inspections/templates', query: { page: '2', pageSize: '25', q: 'stan' } });
  });

  it('leaves out an empty search, and the last page has no more', async () => {
    const w = await resourceWorld({ answers: [reply(200, { data: [], meta: { page: 3, totalPages: 3 } })] });
    expect(await createTemplateSearch(w.deps).search({ q: '', page: 3 })).toMatchObject({ hasMore: false, page: 3 });
    expect(w.api.calls[0]?.query).toEqual({ page: '3', pageSize: '25' });
  });

  it('offline and a failed read are one empty page', async () => {
    const empty = { templates: [], hasMore: false, page: 1, totalPages: 1 };
    const off = await resourceWorld({ online: false });
    expect(await createTemplateSearch(off.deps).search({ q: 'x', page: 1 })).toEqual(empty);
    expect(off.api.calls).toHaveLength(0);
    const failed = await resourceWorld({ answers: [reply(500)] });
    expect(await createTemplateSearch(failed.deps).search({ q: 'x', page: 1 })).toEqual(empty);
  });
});
