import { describe, expect, it } from 'vitest';
import { SnapshotUnreadableError, buildSchema, nextPublishIsAmendment, normalizeTemplateSnapshot, pickRawSnapshot, sliceResults, unwrapResultsResponse } from './loader-schema';

/*
 * The inputs and expected outputs below are the engine loader's own fixtures
 * (app/routes/inspection-edit/loader.server.test.ts), copied rather than imported: the engine is another repository.
 */

const ATTRIBUTES = [
  { id: 'roof_cover_material', name: 'Roof cover material', type: 'select', choices: ['Shingle', 'Tile'] },
  { id: 'roof_cover_condition', name: 'Condition', type: 'select', choices: ['Good', 'Worn'] },
];

const SNAPSHOT = {
  schemaVersion: 2,
  sections: [
    {
      id: 'sec_roof',
      title: 'Roof',
      items: [
        { id: 'itm_cover', label: 'Roof cover', type: 'rich', attributes: ATTRIBUTES },
        { id: 'itm_flashing', label: 'Flashing', type: 'rich' },
      ],
    },
  ],
};

/** report-data's projection: it carries no `attributes` and no `description`. */
const REPORT_SECTIONS = [
  {
    id: 'sec_roof',
    name: 'Roof',
    items: [
      { id: 'itm_cover', name: 'Roof cover', type: 'rich' },
      { id: 'itm_flashing', name: 'Flashing', type: 'rich' },
    ],
  },
];

interface Item {
  id: string;
  label?: string;
  attributes?: unknown[];
  description?: string;
}
const itemsOf = (schema: { sections: unknown[] }): Item[] => (schema.sections as { items?: Item[] }[]).flatMap((s) => s.items ?? []);
const itemById = (schema: { sections: unknown[] }, id: string): Item | undefined => itemsOf(schema).find((i) => i.id === id);

describe('report-data overlay (engine loader fixtures)', () => {
  it('carries the snapshot attributes onto the projected item', () => {
    const item = itemById(buildSchema(SNAPSHOT, REPORT_SECTIONS), 'itm_cover');
    expect(item?.attributes).toHaveLength(2);
    expect((item?.attributes as { id: string }[]).map((a) => a.id)).toEqual(['roof_cover_material', 'roof_cover_condition']);
  });

  it('control: an item the snapshot gives no attributes gets none', () => {
    expect(itemById(buildSchema(SNAPSHOT, REPORT_SECTIONS), 'itm_flashing')?.attributes).toBeUndefined();
  });

  it('control: the projection still wins for the rest (title from name, label from name)', () => {
    const schema = buildSchema(SNAPSHOT, REPORT_SECTIONS);
    expect(schema.sections).toHaveLength(1);
    expect((schema.sections[0] as { title?: string }).title).toBe('Roof');
    expect(itemById(schema, 'itm_cover')?.label).toBe('Roof cover');
  });

  it('does not invent attributes for an item the projection added', () => {
    const added = [{ id: 'sec_roof', name: 'Roof', items: [{ id: 'itm_added_later', name: 'Added later', type: 'rich' }] }];
    expect(itemById(buildSchema(SNAPSHOT, added), 'itm_added_later')?.attributes).toBeUndefined();
  });

  it('leaves the snapshot alone when report-data projects no sections', () => {
    expect(itemById(buildSchema(SNAPSHOT, []), 'itm_cover')?.attributes).toHaveLength(2);
    expect(itemById(buildSchema(SNAPSHOT, undefined), 'itm_cover')?.attributes).toHaveLength(2);
  });

  it('restores a snapshot description the projection dropped; the projection value wins when it has one', () => {
    const snapshot = { schemaVersion: 2, sections: [{ id: 's', title: 'S', items: [{ id: 'a', label: 'A', type: 'rich', description: 'Check all that apply.' }, { id: 'b', label: 'B', type: 'rich', description: 'Old' }, { id: 'c', label: 'C', type: 'rich', description: '' }] }] };
    const projected = [{ id: 's', title: 'S', items: [{ id: 'a', label: 'A', type: 'rich' }, { id: 'b', label: 'B', type: 'rich', description: 'New' }, { id: 'c', label: 'C', type: 'rich' }] }];
    const schema = buildSchema(snapshot, projected);
    expect(itemById(schema, 'a')?.description).toBe('Check all that apply.');
    expect(itemById(schema, 'b')?.description).toBe('New');
    expect(itemById(schema, 'c')?.description).toBeUndefined();
  });

  it('reads a snapshot that arrives as a JSON string', () => {
    expect(itemById(buildSchema(JSON.stringify(SNAPSHOT), REPORT_SECTIONS), 'itm_cover')?.attributes).toHaveLength(2);
  });

  it('falls back to an empty section list when there is no snapshot at all', () => {
    expect(buildSchema(undefined, undefined)).toEqual({ sections: [] });
    expect(buildSchema(null, REPORT_SECTIONS).sections).toHaveLength(1);
  });

  it('does not change the snapshot it was given', () => {
    const before = JSON.stringify(SNAPSHOT);
    buildSchema(SNAPSHOT, REPORT_SECTIONS);
    expect(JSON.stringify(SNAPSHOT)).toBe(before);
  });

  it('an unreadable snapshot string is refused rather than shown as an empty template, with a sentence that carries no parser text', () => {
    for (const run of [() => buildSchema('{not json', REPORT_SECTIONS), () => normalizeTemplateSnapshot('{not json')]) {
      expect(run).toThrow(SnapshotUnreadableError);
      try {
        run();
      } catch (error) {
        expect((error as Error).message).not.toMatch(/JSON|Unexpected|position|token/i);
      }
    }
  });
});

describe('template snapshot', () => {
  it('is the raw snapshot, untouched by the overlay (the engine aliases them when the snapshot arrives as an object)', () => {
    const snapshot = normalizeTemplateSnapshot(SNAPSHOT);
    expect(snapshot).toEqual(SNAPSHOT);
    buildSchema(SNAPSHOT, REPORT_SECTIONS);
    expect(itemById(snapshot, 'itm_cover')?.label).toBe('Roof cover');
    expect((snapshot.sections[0] as { name?: string }).name).toBeUndefined();
  });

  it('parses a string, and defaults to schema version 2 with no sections', () => {
    expect(normalizeTemplateSnapshot(JSON.stringify(SNAPSHOT))).toEqual(SNAPSHOT);
    expect(normalizeTemplateSnapshot(undefined)).toEqual({ schemaVersion: 2, sections: [] });
    expect(normalizeTemplateSnapshot(null)).toEqual({ schemaVersion: 2, sections: [] });
    expect(normalizeTemplateSnapshot('')).toEqual({ schemaVersion: 2, sections: [] });
  });
});

describe('which snapshot is read', () => {
  const own = { schemaVersion: 2, sections: [{ id: 'own', title: 'Own', items: [] }] };
  const top = { schemaVersion: 2, sections: [{ id: 'top', title: 'Top', items: [] }] };
  const source = { schema: { schemaVersion: 2, sections: [{ id: 'source', title: 'Source', items: [] }] } };

  it('prefers the inspection own column, then the top-level one, then the source template', () => {
    expect(pickRawSnapshot({ templateSnapshot: own }, { templateSnapshot: top, template: source })).toBe(own);
    expect(pickRawSnapshot({}, { templateSnapshot: top, template: source })).toBe(top);
    expect(pickRawSnapshot({ templateSnapshot: null }, { template: source })).toBe(source.schema);
    expect(pickRawSnapshot({}, {})).toBeUndefined();
  });
});

describe('nextPublishIsAmendment', () => {
  it('is true only for a published report', () => {
    expect(nextPublishIsAmendment('published')).toBe(true);
    expect(nextPublishIsAmendment('in_progress')).toBe(false);
    expect(nextPublishIsAmendment('submitted')).toBe(false);
    expect(nextPublishIsAmendment(undefined)).toBe(false);
    expect(nextPublishIsAmendment(null)).toBe(false);
  });
});

describe('results map', () => {
  const MAP = {
    '_default:sec:item1': { rating: 'a' },
    '_default:sec:item2': { rating: 'b' },
    'unit-1:sec:item1': { rating: 'c' },
    _inspector_signature: { data: 'sig' },
    // Contain a scope as text without starting with it: a prefix test must tell these from the real keys.
    'legacy_default:sec:item1': { rating: 'x' },
    'zunit-1:sec:item1': { rating: 'y' },
  };

  it('unwraps the three historical envelope shapes like the engine', () => {
    expect(unwrapResultsResponse({ success: true, data: { results: MAP, resultId: 'r1' } })).toBe(MAP);
    expect(unwrapResultsResponse({ data: { data: MAP } })).toBe(MAP);
    expect(unwrapResultsResponse({ data: MAP })).toBe(MAP);
    expect(unwrapResultsResponse(null)).toEqual({});
    expect(unwrapResultsResponse('x')).toEqual({});
    expect(unwrapResultsResponse({ data: 'x' })).toEqual({});
    expect(unwrapResultsResponse({})).toEqual({});
  });

  it('the default scope keeps only _default: keys, so meta keys and unit findings stay out of the first screen', () => {
    const slice = sliceResults(MAP);
    expect(Object.keys(slice)).toEqual(['_default:sec:item1', '_default:sec:item2']);
    expect(slice).not.toHaveProperty('_inspector_signature');
  });

  it('an empty scope is the common scope, the same as none', () => {
    expect(sliceResults(MAP, '')).toEqual(sliceResults(MAP));
    expect(Object.keys(sliceResults(MAP, ''))).toEqual(['_default:sec:item1', '_default:sec:item2']);
    expect(Object.keys(sliceResults(MAP, undefined))).toEqual(['_default:sec:item1', '_default:sec:item2']);
  });

  it('a scope keeps only its own prefix', () => {
    expect(Object.keys(sliceResults(MAP, 'unit-1'))).toEqual(['unit-1:sec:item1']);
    expect(sliceResults(MAP, 'unit-2')).toEqual({});
  });

  it('a scope is a prefix with its colon: unit-1 does not pick up unit-10', () => {
    const map = { 'unit-1:s:i': { a: 1 }, 'unit-10:s:i': { a: 2 } };
    expect(Object.keys(sliceResults(map, 'unit-1'))).toEqual(['unit-1:s:i']);
  });
});
