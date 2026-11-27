import { describe, expect, it } from 'vitest';
import { listPhotoKeys } from './photo-keys';

describe('listPhotoKeys', () => {
  it('names nothing for a body that is not a results response', () => {
    expect(listPhotoKeys(null)).toEqual([]);
    expect(listPhotoKeys('nope')).toEqual([]);
    expect(listPhotoKeys({ success: true, data: null })).toEqual([]);
    expect(listPhotoKeys({ success: true, data: { results: null } })).toEqual([]);
  });

  it('reads photos at the finding, in the data.results shape', () => {
    const body = { success: true, data: { results: { '_default:item-1': { photos: [{ key: 'a' }, { key: 'b' }] }, '_default:item-2': { photos: [{ key: 'c' }] } } } };
    expect(listPhotoKeys(body)).toEqual(['a', 'b', 'c']);
  });

  it('reads the data.data shape and the bare map under data', () => {
    expect(listPhotoKeys({ data: { data: { '_default:item-1': { photos: [{ key: 'a' }] } } } })).toEqual(['a']);
    expect(listPhotoKeys({ data: { '_default:item-1': { photos: [{ key: 'a' }] } } })).toEqual(['a']);
  });

  it('reads photos inside defects, under tabs and customComments', () => {
    const body = {
      data: {
        results: {
          '_default:item-1': {
            tabs: { defects: [{ cannedId: 'd1', photos: [{ key: 'a' }] }] },
            customComments: { defects: [{ id: 'd2', photos: [{ key: 'b' }] }] },
          },
        },
      },
    };
    expect(listPhotoKeys(body)).toEqual(['a', 'b']);
  });

  it('deduplicates a key named twice, and ignores entries without a key', () => {
    const body = { data: { results: { '_default:item-1': { photos: [{ key: 'a' }, { key: 'a' }, {}, { key: 7 }, { key: '' }] } } } };
    expect(listPhotoKeys(body)).toEqual(['a']);
  });

  it('ignores a photos field that is not a list', () => {
    expect(listPhotoKeys({ data: { results: { '_default:item-1': { photos: 'a' } } } })).toEqual([]);
  });
});
