import { describe, expect, it } from 'vitest';
import { createMediaPool, createTemplateSearch } from './resources-media';
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
