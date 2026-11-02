import { extractHeldBackPackage, parsePackage, readPackageSummary, splitPackage } from '@inspectorhub/offline-package';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readLabels, withLabels } from './package-labels';
import { makePackage } from './test-support/import-fixtures';

const BIDI = String.fromCharCode(0x202e);
const read = (zip: Uint8Array, ids: string[]): Record<string, string> => Object.fromEntries(readLabels(zip, ids));

/** The part as a library that keeps every key of the raw entry would write it: same files, the manifest's entries as given. */
function withEntries(part: Uint8Array, entries: unknown[]): Uint8Array {
  const files = unzipSync(part);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<string, unknown>;
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify({ ...manifest, inspections: entries }));
  return zipSync(files);
}

const entriesOf = (zip: Uint8Array): unknown[] => (JSON.parse(new TextDecoder().decode(unzipSync(zip)['manifest.json'])) as { inspections: unknown[] }).inspections;

describe('saving a part: the shared library drops per-inspection labels, so the app puts them back', () => {
  const made = makePackage({ inspections: 3, labels: { 'insp-0': '12 Oak Street', 'insp-1': '34 Birch Lane', 'insp-2': '9 Elm Road' }, photos: { 1: 2 }, updates: { 1: 1 } });
  const all = new Map(readLabels(made.zip, made.ids));

  it('documents the library: since offline-package 0.2.1 a part it cuts keeps the entry\'s label itself', () => {
    // Before 0.2.1 both of these read {} (the library dropped every extra key of the entry). If this turns red the library stopped keeping
    // them again, and `withLabels` is what puts them back. `withLabels` stays either way: it is what keeps an untrusted file's other keys
    // and junk labels out of a part the person shares onward (tests below), and the label it writes comes from the map, never from the part.
    expect(read(extractHeldBackPackage(made.zip, ['insp-1']), ['insp-1'])).toEqual({ 'insp-1': '34 Birch Lane' });
    expect(read(splitPackage(made.zip, ['insp-1']).part, ['insp-1'])).toEqual({ 'insp-1': '34 Birch Lane' });
  });

  /** A part as the library wrote it before 0.2.1: the same entries without their label. */
  const withoutLabels = (part: Uint8Array): Uint8Array => withEntries(part, entriesOf(part).map((entry) => {
    const { label: _label, ...rest } = entry as Record<string, unknown>;
    return rest;
  }));

  it('withLabels puts back the label of the inspections the part holds, and only those (on a part that lost them)', () => {
    const part = withoutLabels(extractHeldBackPackage(made.zip, ['insp-1']));
    expect(read(part, ['insp-1'])).toEqual({});
    const labelled = withLabels(part, all);
    expect(read(labelled, ['insp-0', 'insp-1', 'insp-2'])).toEqual({ 'insp-1': '34 Birch Lane' });
    expect(readPackageSummary(labelled).manifest.inspections.map((i) => i.id)).toEqual(['insp-1']);
  });

  it('the labelled part is still a package the shared parser accepts, with the same contents', () => {
    const part = withoutLabels(extractHeldBackPackage(made.zip, ['insp-1', 'insp-2']));
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

  it('a part that already carries the right labels (what the library writes since 0.2.1) is handed back untouched', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    expect(withLabels(part, all)).toBe(part);
    // A part that never had a label, and nothing to put back, is untouched too.
    const bare = withoutLabels(part);
    expect(withLabels(bare, new Map())).toBe(bare);
    expect(withLabels(bare, new Map([['insp-0', 'Not in this part']]))).toBe(bare);
  });

  it('the label comes from the map, never from the part: a label the part carries and the map does not know is dropped', () => {
    const part = extractHeldBackPackage(made.zip, ['insp-1']);
    expect(read(part, ['insp-1'])).toEqual({ 'insp-1': '34 Birch Lane' });
    expect(read(withLabels(part, new Map()), ['insp-1'])).toEqual({});
    expect(read(withLabels(part, new Map([['insp-1', '1 Other Way']])), ['insp-1'])).toEqual({ 'insp-1': '1 Other Way' });
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

  describe('a part that carries whatever the untrusted file put in its entries (a library that keeps every key)', () => {
    const base = extractHeldBackPackage(made.zip, ['insp-1']);
    const reportId = (entriesOf(base)[0] as { reportId: string }).reportId;

    it('rebuilds each entry from id, reportId and the label of the map only: a junk label and every other key are dropped', () => {
      const hostile = withEntries(base, [{ id: 'insp-1', reportId, label: { nested: ['x'] }, notes: 'x'.repeat(1_000_000), extra: 1, ['__proto__']: 'p' }]);
      const clean = withLabels(hostile, new Map([['insp-1', '34 Birch Lane']]));
      expect(entriesOf(clean)).toEqual([{ id: 'insp-1', reportId, label: '34 Birch Lane' }]);
      expect(Object.keys(entriesOf(clean)[0] as object).sort()).toEqual(['id', 'label', 'reportId']);
      expect(() => parsePackage(clean)).not.toThrow();
    });

    it('a label that was junk in the file and has no clean one in the map ends up with no label, not with the junk', () => {
      const hostile = withEntries(base, [{ id: 'insp-1', reportId, label: 'y'.repeat(2_000_000) }]);
      const clean = withLabels(hostile, new Map());
      expect(entriesOf(clean)).toEqual([{ id: 'insp-1', reportId }]);
      expect(zipSize(clean)).toBeLessThan(zipSize(hostile));
    });

    it('a reportId that is not a string is not carried into the part (the importer then rejects that part, which is better than passing junk on)', () => {
      const odd = withEntries(base, [{ id: 'insp-1', reportId: { nested: ['x'] }, label: '34 Birch Lane' }]);
      const clean = withLabels(odd, new Map([['insp-1', '34 Birch Lane']]));
      expect(entriesOf(clean)).toEqual([{ id: 'insp-1', label: '34 Birch Lane' }]);
      expect(() => parsePackage(clean)).toThrow();
    });

    it('control: an honest part (the right label, nothing else) is handed back as it is, without being inflated and zipped again', () => {
      const honest = withEntries(base, [{ id: 'insp-1', reportId, label: '34 Birch Lane' }]);
      expect(withLabels(honest, new Map([['insp-1', '34 Birch Lane']]))).toBe(honest);
    });

    it('control: the order of the keys is not a difference', () => {
      const reordered = withEntries(base, [{ label: '34 Birch Lane', reportId, id: 'insp-1' }]);
      expect(withLabels(reordered, new Map([['insp-1', '34 Birch Lane']]))).toBe(reordered);
    });

    it('control: one extra key on an otherwise right entry is enough to rebuild it', () => {
      const one = withEntries(base, [{ id: 'insp-1', reportId, label: '34 Birch Lane', extra: 1 }]);
      const clean = withLabels(one, new Map([['insp-1', '34 Birch Lane']]));
      expect(clean).not.toBe(one);
      expect(entriesOf(clean)).toEqual([{ id: 'insp-1', reportId, label: '34 Birch Lane' }]);
    });
  });
});

const zipSize = (zip: Uint8Array): number => zip.byteLength;
