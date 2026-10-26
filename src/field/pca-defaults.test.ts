import { describe, expect, it } from 'vitest';
import { ENGINE_PCA_VALUES as fixture } from './test-fixtures/engine-pca-values';
import { commercialPresets, resolvePcaNarrative, resolveRelianceText } from './pca-defaults';

/**
 * The expected values are the engine's own, extracted from its source by script into `test-fixtures/engine-pca-values.ts`.
 * They are not retyped here, so a local copy that drifts from the engine fails against the fixture.
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

  it('the commercial presets equal the engine ones, field by field: id, label, type, group, required, unit and options, in order', () => {
    const presets = commercialPresets();
    expect(Object.keys(presets)).toEqual(Object.keys(fixture.commercialPresets));
    expect(presets).toEqual(fixture.commercialPresets);
    expect(Object.keys(presets).every((key) => key.startsWith('commercial:'))).toBe(true);
  });

  it('control: the comparison sees a changed label, a changed option and a changed flag', () => {
    const changed = commercialPresets();
    const first = changed['commercial:office']?.[0];
    if (first === undefined) throw new Error('no office preset');
    first.label = 'Year built (edited)';
    expect(changed).not.toEqual(fixture.commercialPresets);
    const options = commercialPresets();
    options['commercial:office']?.[3]?.options?.splice(0, 1, 'Z');
    expect(options).not.toEqual(fixture.commercialPresets);
    const flag = commercialPresets();
    const target = flag['commercial:retail']?.[1];
    if (target === undefined) throw new Error('no retail field');
    target.required = false;
    expect(flag).not.toEqual(fixture.commercialPresets);
  });

  it('returns a fresh copy: changing one answer does not change the next', () => {
    const first = commercialPresets();
    const office = first['commercial:office'];
    expect(office).toBeDefined();
    office?.pop();
    office?.[3]?.options?.pop();
    const second = commercialPresets()['commercial:office'];
    expect(second?.length).toBe(fixture.commercialPresets['commercial:office'].length);
    expect(second?.[3]?.options).toHaveLength(4);
  });
});
