// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { parsePackage, readPackageSummary } from '@inspectorhub/offline-package';
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiOutcome } from '../../field/api-client';
import { readLabels } from '../../offline/package-labels';
import { makePackage } from '../../offline/test-support/import-fixtures';
import { idsOf, ok, refused, runToResult } from '../test-support/import-test-kit';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const BIDI = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);
const notFound1 = (_n: number, b: Uint8Array): ApiOutcome => (idsOf(b).includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(b));
const rowTexts = (): string[] => within(screen.getByTestId('import-group-not_found')).getAllByTestId('import-row').map((r) => r.textContent ?? '');

describe('the result page names inspections by address', () => {
  it('shows the address from the file, and keeps the id for support in Details', async () => {
    await runToResult(makePackage({ inspections: 3, labels: { 'insp-1': '12 Oak Street' } }), notFound1);
    expect(rowTexts()).toEqual(['12 Oak Street']);
    expect(screen.getByTestId('import-result').textContent).not.toContain('insp-1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('import-details')).toHaveTextContent('insp-1 (12 Oak Street): not_found.');
  });

  it('an old file without addresses renders exactly as before', async () => {
    await runToResult(makePackage({ inspections: 3 }), notFound1);
    expect(rowTexts()).toEqual(['Inspection insp-1']);
  });

  it('html in an address is shown as the text it is, never as markup', async () => {
    await runToResult(makePackage({ inspections: 3, labels: { 'insp-1': '<b>12 Oak</b> <img src=x onerror=alert(1)> St' } }), notFound1);
    const row = within(screen.getByTestId('import-group-not_found')).getByTestId('import-row');
    expect(row.textContent).toBe('<b>12 Oak</b> <img src=x onerror=alert(1)> St');
    expect(row.querySelector('b, img')).toBeNull();
  });

  it('a hostile address (direction controls, control characters, 10 KB) is cleaned and cut before it is shown', async () => {
    await runToResult(makePackage({ inspections: 3, labels: { 'insp-1': `${BIDI}A${NUL}${'b'.repeat(10_000)}` } }), notFound1);
    const text = rowTexts()[0] ?? '';
    expect(text).not.toContain(BIDI);
    expect(text).not.toContain(NUL);
    expect(Array.from(text).length).toBeLessThanOrEqual(120);
    expect(screen.getByTestId('import-result').textContent?.length ?? 0).toBeLessThan(5000);
  });

  it.each([
    ['an object', { street: 'x' }],
    ['a number', 7],
    ['an empty string', ''],
  ])('%s is not an address: the row falls back to the id', async (_name, value) => {
    await runToResult(makePackage({ inspections: 3, labels: { 'insp-1': value } }), notFound1);
    expect(rowTexts()).toEqual(['Inspection insp-1']);
  });

  it('"Save" hands over a file that still carries the address of what it holds, and no other', async () => {
    const view = await runToResult(makePackage({ inspections: 3, labels: { 'insp-0': '1 First St', 'insp-1': '12 Oak Street', 'insp-2': '3 Third St' } }), notFound1);
    await userEvent.setup().click(screen.getByTestId('import-primary-action'));
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    const shared = view.world.sharer.calls[0]?.bytes ?? new Uint8Array();
    expect(readPackageSummary(shared).manifest.inspections.map((i) => i.id)).toEqual(['insp-1']);
    expect(Object.fromEntries(readLabels(shared, ['insp-0', 'insp-1', 'insp-2']))).toEqual({ 'insp-1': '12 Oak Street' });
    expect(() => parsePackage(shared)).not.toThrow();
  });

  it('only the inspections that have an address are renamed', async () => {
    await runToResult(makePackage({ inspections: 4, labels: { 'insp-1': '12 Oak Street' } }), (_n, b) => {
      const ids = idsOf(b);
      if (ids.includes('insp-1')) return refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' });
      if (ids.includes('insp-2')) return refused(404, 'NOT_FOUND', { inspectionId: 'insp-2' });
      return ok(b);
    });
    expect(rowTexts()).toEqual(['12 Oak Street', 'Inspection insp-2']);
  });
});
