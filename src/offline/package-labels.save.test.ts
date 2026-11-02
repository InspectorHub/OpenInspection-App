import { extractHeldBackPackage, parsePackage, readPackageSummary, splitPackage } from '@inspectorhub/offline-package';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readLabels, withLabels } from './package-labels';
import { makePackage } from './test-support/import-fixtures';

const BIDI = String.fromCharCode(0x202e);
const read = (zip: Uint8Array, ids: string[]): Record<string, string> => Object.fromEntries(readLabels(zip, ids));

describe('saving a part: the shared library drops per-inspection labels, so the app puts them back', () => {
  const made = makePackage({ inspections: 3, labels: { 'insp-0': '12 Oak Street', 'insp-1': '34 Birch Lane', 'insp-2': '9 Elm Road' }, photos: { 1: 2 }, updates: { 1: 1 } });
  const all = new Map(readLabels(made.zip, made.ids));

  it('documents the library: a part it cuts does not keep an entry\'s extra key', () => {
    // If this ever turns red the library keeps labels itself, and `withLabels` can go.
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    expect(read(part, ['insp-1'])).toEqual({});
    expect(read(splitPackage(made.zip, ['insp-1']).part, ['insp-1'])).toEqual({});
  });

  it('withLabels puts back the label of the inspections the part holds, and only those', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    const labelled = withLabels(part, all);
    expect(read(labelled, ['insp-0', 'insp-1', 'insp-2'])).toEqual({ 'insp-1': '34 Birch Lane' });
    expect(readPackageSummary(labelled).manifest.inspections.map((i) => i.id)).toEqual(['insp-1']);
  });

  it('the labelled part is still a package the shared parser accepts, with the same contents', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1', 'insp-2']);
    const labelled = withLabels(part, all);
    expect(() => parsePackage(labelled)).not.toThrow();
    expect(readPackageSummary(labelled).counts).toEqual(readPackageSummary(part).counts);
    const before = unzipSync(part);
    const after = unzipSync(labelled);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const name of Object.keys(before)) {
      if (name === 'manifest.json') continue;
      expect(after[name], name).toEqual(before[name]);
    }
  });

  it('with nothing to put back the part is handed back untouched', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    expect(withLabels(part, new Map())).toBe(part);
    expect(withLabels(part, new Map([['insp-0', 'Not in this part']]))).toBe(part);
  });

  it('a label in the map is cleaned again before it is written', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    const labelled = withLabels(part, new Map([['insp-1', `Oak${BIDI} Street`]]));
    expect(read(labelled, ['insp-1'])).toEqual({ 'insp-1': 'Oak Street' });
  });

  it('something that is not a package is handed back as it is, never thrown at the person', () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(withLabels(junk, all)).toBe(junk);
  });
});
