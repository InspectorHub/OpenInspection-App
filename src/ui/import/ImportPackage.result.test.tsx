// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readPackageSummary } from '@inspectorhub/offline-package';
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmedBody, makePackage } from '../../offline/test-support/import-fixtures';
import { idsOf, ok, refused, runToResult } from '../test-support/import-test-kit';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

describe('the result', () => {
  it('everything imported: four numbers and a plain sentence, nothing left behind', async () => {
    const made = makePackage({ inspections: 3, updates: { 0: 1 } });
    await runToResult(made, (_n, b) => ok(b));
    const result = screen.getByTestId('import-result');
    expect(within(result).getByText('Everything in this package was imported.')).toBeVisible();
    expect(within(result).getByText('Imported').nextElementSibling?.textContent).toBe('3');
    expect(screen.queryByTestId('import-held-back')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import this file again' })).toBeNull();
  });

  it('a 404 that names an inspection lists it by name, with the faithful explanation, and imports the rest', async () => {
    const made = makePackage({ inspections: 3 });
    await runToResult(made, (_n, b) => (idsOf(b).includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(b)));
    const held = screen.getByTestId('import-held-back');
    const rows = within(held).getAllByTestId('held-back-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Inspection insp-1');
    expect(rows[0]).toHaveTextContent('Not found');
    expect(rows[0]).toHaveTextContent('Server answer: 404 NOT_FOUND');
    expect(within(held).getByText('This inspection does not exist in this company.')).toBeVisible();
    expect(screen.getByText('Imported').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByRole('button', { name: 'Import this file again' })).toBeVisible();
  });

  it('an expired package says the days the server named', async () => {
    await runToResult(makePackage({ inspections: 2 }), () => refused(422, 'PACKAGE_EXPIRED', { maxAgeDays: 30 }));
    const group = screen.getByTestId('held-back-group-package_rejected:expired');
    expect(group).toHaveTextContent('more than 30 days old');
    expect(within(group).getAllByTestId('held-back-row')).toHaveLength(2);
    expect(screen.getByText(/Nothing in this package could be imported/)).toBeVisible();
  });

  it('queued changes the server refused are listed on their own and are not counted as left behind', async () => {
    const made = makePackage({ inspections: 2, updates: { 0: 1 } });
    await runToResult(made, (_n, b) => ({
      kind: 'response',
      status: 200,
      json: confirmedBody(b, { applied: 0, failed: [{ idempotencyKey: 'k-insp-0-0', op: 'inspection.update', inspectionId: 'insp-0', status: 422, reason: 'invalid' }] }),
    }));
    const attention = screen.getByTestId('import-attention');
    expect(attention).toHaveTextContent('inspection.update on inspection insp-0');
    expect(attention).toHaveTextContent('Server answer: 422 - Reason: invalid');
    expect(screen.getByText('Not imported').nextElementSibling?.textContent).toBe('0');
    expect(screen.getByText('Refused changes').nextElementSibling?.textContent).toBe('1');
    expect(screen.queryByTestId('import-held-back')).toBeNull();
  });

  it('"Save this part" writes a package of just that inspection and opens the share sheet', async () => {
    const made = makePackage({ inspections: 3, photos: { 1: 1 } });
    const view = await runToResult(made, (_n, b) => (idsOf(b).includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(b)));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save this part' }));
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    const shared = view.world.sharer.calls[0]?.bytes;
    expect(shared).toBeDefined();
    const summary = readPackageSummary(shared ?? new Uint8Array());
    expect(summary.manifest.inspections.map((i) => i.id)).toEqual(['insp-1']);
    expect(summary.counts.photos).toBe(1);
    expect(await screen.findByText(/Saved\. Choose where to keep it/)).toBeVisible();
  });

  it('control: a share sheet that fails says so and changes nothing else', async () => {
    const made = makePackage({ inspections: 2 });
    const view = await runToResult(made, (_n, b) => (idsOf(b).includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(b)));
    view.world.sharer.mode = 'error';
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save this part' }));
    expect(await screen.findByText(/could not be saved/)).toBeVisible();
    expect(screen.getByTestId('import-held-back')).toBeVisible();
  });

  it('two taps on Save in one frame open the sheet once', async () => {
    const made = makePackage({ inspections: 2 });
    const view = await runToResult(made, (_n, b) => (idsOf(b).includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(b)));
    const save = screen.getByRole('button', { name: 'Save this part' });
    await act(async () => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    expect(view.world.sharer.calls).toHaveLength(1);
  });
});

describe('an import that cannot go on', () => {
  it.each([
    ['auth', 'Sign in again'],
    ['locked', 'This device is locked'],
    ['upgrade', 'Update the app'],
    ['server_too_old', 'The server is too old'],
  ] as const)('"%s" ends in one clear instruction, not a list of unconfirmed inspections', async (problem, title) => {
    const view = await runToResult(makePackage({ inspections: 4 }), () => ({ kind: 'problem', problem }));
    expect(within(screen.getByTestId('import-result')).getByText(title)).toBeVisible();
    expect(view.calls).toHaveLength(1);
    expect(screen.queryByTestId('import-held-back')).toBeNull();
    expect(screen.getByTestId('import-unsent')).toHaveTextContent('4 inspections were not sent.');
  });

  it('a part that lost its answer and was then stopped is "not confirmed", never "not sent"', async () => {
    const view = await runToResult(makePackage({ inspections: 3 }), (n) => ({ kind: 'problem', problem: n === 1 ? 'offline' : 'auth' }));
    expect(view.calls).toHaveLength(2);
    expect(within(screen.getByTestId('import-result')).getByText('Sign in again')).toBeVisible();
    expect(screen.queryByTestId('import-unsent')).toBeNull();
    expect(screen.queryByText(/were not sent/)).toBeNull();
    expect(screen.getByTestId('held-back-group-gave_up')).toHaveTextContent('did not confirm this part in time');
    expect(screen.getByTestId('held-back-group-gave_up')).toHaveTextContent('importing is safe to repeat');
  });

  it('control: no answer at all ends in the retry limit and the ordinary unconfirmed explanation', async () => {
    const view = await runToResult(makePackage({ inspections: 2 }), () => ({ kind: 'problem', problem: 'offline' }));
    expect(view.calls).toHaveLength(5);
    expect(screen.getByTestId('held-back-group-gave_up')).toHaveTextContent('did not confirm this part in time');
    expect(screen.queryByText('Sign in again')).toBeNull();
  });
});

