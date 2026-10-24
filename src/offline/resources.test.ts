import { describe, expect, it } from 'vitest';
import { RESERVED_INSPECTION_IDS } from './registry';
import { DEFAULT_JSON_LIMITS, EDITOR_READ_KEY_MAP, GLOBAL_RESOURCE_PATHS, baseInspectionPaths, conditionalInspectionPaths, hasSuccessEnvelope, isJsonContentType, jsonWithinLimits } from './resources';

const limits = { ...DEFAULT_JSON_LIMITS, maxDepth: 5, maxNodes: 50, maxArrayLength: 10 };

describe('the resource set', () => {
  it('reads the three things every editor needs, the inspection row first', () => {
    expect(baseInspectionPaths('abc-1')).toEqual(['/api/inspections/abc-1', '/api/inspections/abc-1/results', '/api/inspections/abc-1/report-data']);
  });

  it('the global reads are the five the editor loads once per session', () => {
    expect([...GLOBAL_RESOURCE_PATHS]).toEqual(['/api/session/context', '/api/tags', '/api/recommendations', '/api/contractor-types', '/api/admin/defect-categories']);
  });

  it.each(['', 'a/b', '..', 'a b', 'a?x=1', 'a#b', 'a%2Fb', 'x'.repeat(65), '$global', ...RESERVED_INSPECTION_IDS])('refuses %j as a path segment', (id) => {
    expect(() => baseInspectionPaths(id)).toThrow();
  });

  it('accepts the longest valid id', () => {
    expect(baseInspectionPaths('x'.repeat(64))[0]).toBe(`/api/inspections/${'x'.repeat(64)}`);
  });

  describe('what the inspection row asks for besides the base set', () => {
    const body = (inspection: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ success: true, data: { inspection, ...extra } });

    it('a single-family job reads nothing more', () => {
      expect(conditionalInspectionPaths('i1', body({ id: 'i1', propertyType: 'single_family' }))).toEqual([]);
    });

    it('a multi-unit, commercial or unclassified job reads units and progress, a per-unit single-family one too', () => {
      const units = ['/api/inspections/i1/units', '/api/inspections/i1/unit-progress'];
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'multi_family' }))).toEqual(units);
      expect(conditionalInspectionPaths('i1', body({}))).toEqual(units);
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family', unitInspectionMode: 'per_unit' }))).toEqual(units);
    });

    it('a full PCA report reads the compliance artifacts; a light commercial one does not', () => {
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'commercial', reportTier: 'full_pca' }))).toContain('/api/inspections/i1/compliance');
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'commercial', reportTier: 'light_commercial' }))).not.toContain('/api/inspections/i1/compliance');
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'commercial' }))).not.toContain('/api/inspections/i1/compliance');
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'multi_family', reportTier: 'full_pca' }))).not.toContain('/api/inspections/i1/compliance');
    });

    it('commercial jobs read their cost lines', () => {
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'commercial' }))).toContain('/api/inspections/i1/cost-items');
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family' }))).not.toContain('/api/inspections/i1/cost-items');
    });

    it('a template that declares a statutory form reads its answers and coverage, from the row or the template, as an object or a string', () => {
      const statutory = ['/api/inspections/i1/statutory-details', '/api/inspections/i1/statutory-form/coverage'];
      const snapshot = { statutoryForm: { id: 'trec' }, sections: [] };
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family', templateSnapshot: snapshot }))).toEqual(statutory);
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family', templateSnapshot: JSON.stringify(snapshot) }))).toEqual(statutory);
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family' }, { template: { schema: snapshot } }))).toEqual(statutory);
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family', templateSnapshot: { sections: [] } }))).toEqual([]);
    });

    it('an unparseable snapshot or a body of the wrong shape asks for the cautious default, never throws', () => {
      expect(conditionalInspectionPaths('i1', body({ propertyType: 'single_family', templateSnapshot: '{not json' }))).toEqual([]);
      expect(conditionalInspectionPaths('i1', null)).toEqual(['/api/inspections/i1/units', '/api/inspections/i1/unit-progress']);
      expect(conditionalInspectionPaths('i1', { success: true, data: 5 })).toEqual(['/api/inspections/i1/units', '/api/inspections/i1/unit-progress']);
    });
  });
});

describe('the response guard', () => {
  it('accepts json content types only', () => {
    expect(isJsonContentType(new Headers({ 'content-type': 'application/json' }))).toBe(true);
    expect(isJsonContentType(new Headers({ 'content-type': 'Application/JSON; charset=utf-8' }))).toBe(true);
    expect(isJsonContentType(new Headers({ 'content-type': 'application/problem+json' }))).toBe(true);
    expect(isJsonContentType(new Headers({ 'content-type': 'text/html; charset=utf-8' }))).toBe(false);
    expect(isJsonContentType(new Headers({ 'content-type': 'text/plain' }))).toBe(false);
    expect(isJsonContentType(new Headers())).toBe(false);
  });

  it('wants the success envelope with a data member', () => {
    expect(hasSuccessEnvelope({ success: true, data: [] })).toBe(true);
    expect(hasSuccessEnvelope({ success: true, data: null })).toBe(true);
    expect(hasSuccessEnvelope({ success: true })).toBe(false);
    expect(hasSuccessEnvelope({ success: false, data: [] })).toBe(false);
    expect(hasSuccessEnvelope({ success: 'true', data: [] })).toBe(false);
    expect(hasSuccessEnvelope([])).toBe(false);
    expect(hasSuccessEnvelope(null)).toBe(false);
    expect(hasSuccessEnvelope(undefined)).toBe(false);
    expect(hasSuccessEnvelope('<html>')).toBe(false);
  });

  it('bounds depth, node count and array length, and accepts the same shape inside the bounds', () => {
    const nested = (depth: number): unknown => (depth === 0 ? 1 : { a: nested(depth - 1) });
    expect(jsonWithinLimits(nested(4), limits)).toBe(true);
    expect(jsonWithinLimits(nested(6), limits)).toBe(false);
    expect(jsonWithinLimits(Array.from({ length: 10 }, () => 1), limits)).toBe(true);
    expect(jsonWithinLimits(Array.from({ length: 11 }, () => 1), limits)).toBe(false);
    expect(jsonWithinLimits({ rows: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }, limits)).toBe(false);
    expect(jsonWithinLimits({ rows: [[1, 2, 3], [1, 2, 3]] }, limits)).toBe(true);
  });

  it('walks a very deep value without recursing', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(jsonWithinLimits(deep, DEFAULT_JSON_LIMITS)).toBe(false);
  });
});

describe('the editor read to cache key map', () => {
  const ID = 'i1';
  const everyInspectionPath = (): string[] => {
    const everything = { success: true, data: { inspection: { propertyType: 'commercial', reportTier: 'full_pca', templateSnapshot: { statutoryForm: true } } } };
    return [...baseInspectionPaths(ID), ...conditionalInspectionPaths(ID, everything)];
  };
  const keysOfMap = (): string[] => EDITOR_READ_KEY_MAP.map((entry) => entry.cacheKey.replace(':id', ID));

  it('has an entry for every resource the package caches, and no entry for one it does not', () => {
    const cached = [...everyInspectionPath(), ...GLOBAL_RESOURCE_PATHS];
    expect([...keysOfMap()].sort()).toEqual([...cached].sort());
    expect(new Set(keysOfMap()).size).toBe(keysOfMap().length);
  });

  it('maps the scoped results read to the unscoped key the package stores', () => {
    const results = EDITOR_READ_KEY_MAP.find((entry) => entry.cacheKey.endsWith('/results'));
    expect(results).toEqual({ editorRead: '/api/inspections/:id/results?scope=_default', cacheKey: '/api/inspections/:id/results' });
  });
});
