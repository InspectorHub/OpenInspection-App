import { describe, expect, it } from 'vitest';
import { ENGINE_PCA_VALUES as fixture } from './test-fixtures/engine-pca-values';
import { commercialPresets, resolvePcaNarrative, resolveRelianceText } from './pca-defaults';

/**
 * The expected values are the engine's own, extracted from its source into the fixture. They are not retyped here, so
 * a local copy that drifts from the engine fails against the fixture.
 */
describe('pca defaults against the engine values', () => {
  it('an inspection with no stored narrative resolves to the engine seed, block for block', () => {
    expect(resolvePcaNarrative(undefined)).toEqual(fixture.pcaNarrativeSeed);
    expect(resolvePcaNarrative(null)).toEqual(fixture.pcaNarrativeSeed);
    expect(resolvePcaNarrative('text')).toEqual(fixture.pcaNarrativeSeed);
  });

  it('a stored block replaces its seed; blank, missing and unknown keys fall back or are ignored', () => {
    const out = resolvePcaNarrative({ purpose: 'Custom purpose.', scopeOfWork: '   ', oldFiveBlockShape: 'x', userReliance: 'not a block' });
    expect(out.purpose).toBe('Custom purpose.');
    expect(out.scopeOfWork).toBe(fixture.pcaNarrativeSeed.scopeOfWork);
    expect(out).not.toHaveProperty('oldFiveBlockShape');
    expect(out).not.toHaveProperty('userReliance');
    expect(Object.keys(out).sort()).toEqual(Object.keys(fixture.pcaNarrativeSeed).sort());
  });

  it('reliance text is the engine wording unless the inspector stored their own, per field', () => {
    expect(resolveRelianceText(undefined)).toEqual(fixture.relianceTemplates);
    const mixed = resolveRelianceText({ pointInTime: 'Own wording.', siteSpecific: '' });
    expect(mixed).toEqual({ ...fixture.relianceTemplates, pointInTime: 'Own wording.' });
  });

  it('the commercial presets carry exactly the engine subtypes and field ids, in order', () => {
    const presets = commercialPresets();
    expect(Object.keys(presets)).toEqual(Object.keys(fixture.commercialPresetFieldIds));
    for (const [key, ids] of Object.entries(fixture.commercialPresetFieldIds)) {
      expect(presets[key]?.map((f) => f.id)).toEqual(ids);
    }
    expect(Object.keys(presets).every((key) => key.startsWith('commercial:'))).toBe(true);
  });

  it('returns a fresh copy: changing one answer does not change the next', () => {
    const first = commercialPresets();
    const office = first['commercial:office'];
    expect(office).toBeDefined();
    office?.pop();
    office?.[3]?.options?.pop();
    const second = commercialPresets()['commercial:office'];
    expect(second?.length).toBe(fixture.commercialPresetFieldIds['commercial:office'].length);
    expect(second?.[3]?.options).toHaveLength(4);
  });
});
