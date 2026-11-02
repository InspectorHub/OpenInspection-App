import { parsePackage, readPackageSummary, runImport } from '@inspectorhub/offline-package';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TITLE_MAX } from './cached-address';
import { readLabels } from './package-labels';
import { confirmedBody, makePackage } from './test-support/import-fixtures';

const BIDI = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);
const read = (zip: Uint8Array, ids: string[]): Record<string, string> => Object.fromEntries(readLabels(zip, ids));

/** A package whose manifest entries are written exactly as given, to test what a hostile writer could put there. */
function withManifestEntries(entries: unknown[], extra: Record<string, unknown> = {}): Uint8Array {
  const base = makePackage({ inspections: 2 });
  const files = unzipSync(base.zip);
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<string, unknown>;
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify({ ...manifest, inspections: entries, ...extra }));
  return zipSync(files);
}

describe('a package with labels is a package the shared library accepts (compatibility proof)', () => {
  const made = makePackage({ inspections: 3, labels: { 'insp-0': '12 Oak Street', 'insp-2': '9 Elm Road' }, updates: { 1: 1 }, photos: { 0: 1 } });

  it('the shared reader reads it and counts it as it would without labels', () => {
    const plain = makePackage({ inspections: 3, updates: { 1: 1 }, photos: { 0: 1 } });
    expect(readPackageSummary(made.zip).counts).toEqual(readPackageSummary(plain.zip).counts);
    expect(readPackageSummary(made.zip).manifest.inspections.map((i) => i.id)).toEqual(['insp-0', 'insp-1', 'insp-2']);
  });

  it('the shared reader drops the label itself, which is why the app reads it from the manifest entry', () => {
    expect(readPackageSummary(made.zip).manifest.inspections[0]).not.toHaveProperty('label');
  });

  it('the importer\'s own parser (the one runImport uses) accepts it', () => {
    expect(() => parsePackage(made.zip)).not.toThrow();
  });

  it('a whole import of it succeeds', async () => {
    const report = await runImport(made.zip, (bytes) => Promise.resolve({ status: 200, body: confirmedBody(bytes) }), { sleep: () => Promise.resolve() });
    expect(report.imported).toEqual(['insp-0', 'insp-1', 'insp-2']);
    expect(report.heldBack).toEqual([]);
  });
});

describe('reading the labels', () => {
  it('returns the label of each inspection that has one', () => {
    const made = makePackage({ inspections: 3, labels: { 'insp-0': '12 Oak Street', 'insp-2': '9 Elm Road' } });
    expect(read(made.zip, made.ids)).toEqual({ 'insp-0': '12 Oak Street', 'insp-2': '9 Elm Road' });
  });

  it('an old package without labels gives none', () => {
    const made = makePackage({ inspections: 2 });
    expect(read(made.zip, made.ids)).toEqual({});
  });

  it('cleans a label: text-direction controls and control characters go, whitespace is collapsed, edges trimmed', () => {
    const made = makePackage({ inspections: 1, labels: { 'insp-0': `  12${BIDI} Oak${NUL}\t\n  Street  ` } });
    expect(read(made.zip, made.ids)).toEqual({ 'insp-0': '12 Oak Street' });
  });

  it('a 10 KB label is cut to the length the work list shows addresses at', () => {
    const made = makePackage({ inspections: 1, labels: { 'insp-0': 'x'.repeat(10_000) } });
    const label = read(made.zip, made.ids)['insp-0'] ?? '';
    expect(Array.from(label)).toHaveLength(TITLE_MAX);
    expect(label.endsWith('…')).toBe(true);
  });

  it('control: a label at the limit is kept whole', () => {
    const exact = 'y'.repeat(TITLE_MAX);
    const made = makePackage({ inspections: 1, labels: { 'insp-0': exact } });
    expect(read(made.zip, made.ids)['insp-0']).toBe(exact);
  });

  it.each([
    ['an object', { text: 'x' }],
    ['an array', ['x']],
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    ['an empty string', ''],
    ['only spaces and controls', `  ${NUL} \t${BIDI} `],
  ])('%s is no label: the inspection falls back to its id', (_name, value) => {
    const made = makePackage({ inspections: 1, labels: { 'insp-0': value } });
    expect(read(made.zip, made.ids)).toEqual({});
  });

  it('html is kept as the plain text it is (it is only ever rendered as text)', () => {
    const made = makePackage({ inspections: 1, labels: { 'insp-0': '<img src=x onerror=alert(1)> 5 Pine Rd' } });
    expect(read(made.zip, made.ids)['insp-0']).toBe('<img src=x onerror=alert(1)> 5 Pine Rd');
  });

  it('a label for an id that is not in the manifest list is ignored, whether it sits in an extra entry or in a map beside the list', () => {
    const zip = withManifestEntries(
      [
        { id: 'insp-0', reportId: 'r0', label: 'Real' },
        { id: 'ghost', reportId: 'r9', label: 'Ghost' },
      ],
      { labels: { 'insp-1': 'Smuggled' } },
    );
    expect(read(zip, ['insp-0', 'insp-1'])).toEqual({ 'insp-0': 'Real' });
  });

  it('an id listed twice gets no label at all: which one is true cannot be told', () => {
    const zip = withManifestEntries([
      { id: 'insp-0', reportId: 'r0', label: 'First' },
      { id: 'insp-0', reportId: 'r0', label: 'Second' },
      { id: 'insp-1', reportId: 'r1', label: 'Fine' },
    ]);
    expect(read(zip, ['insp-0', 'insp-1'])).toEqual({ 'insp-1': 'Fine' });
  });

  it('an entry that is not an object, or has an id that is not a string, is skipped', () => {
    const zip = withManifestEntries(['text', null, 7, { id: 5, label: 'Num' }, { reportId: 'r', label: 'No id' }, { id: 'insp-1', reportId: 'r1', label: 'Kept' }]);
    expect(read(zip, ['insp-0', 'insp-1'])).toEqual({ 'insp-1': 'Kept' });
  });

  it('a manifest that is not JSON, or not there, gives none and does not throw', () => {
    const files = unzipSync(makePackage({ inspections: 1 }).zip);
    files['manifest.json'] = new TextEncoder().encode('{not json');
    expect(read(zipSync(files), ['insp-0'])).toEqual({});
    delete files['manifest.json'];
    expect(read(zipSync(files), ['insp-0'])).toEqual({});
    expect(read(new Uint8Array([1, 2, 3]), ['insp-0'])).toEqual({});
  });

  it('a hostile id in the expected list cannot reach a prototype key', () => {
    const made = makePackage({ inspections: 1, labels: { 'insp-0': 'A' } });
    expect(read(made.zip, ['__proto__', 'constructor', 'insp-0'])).toEqual({ 'insp-0': 'A' });
  });
});

