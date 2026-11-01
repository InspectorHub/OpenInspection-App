// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readPackageSummary } from '@inspectorhub/offline-package';
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmedBody, makePackage } from '../../offline/test-support/import-fixtures';
import type { ApiOutcome } from '../../field/api-client';
import { idsOf, ok, refused, runToResult } from '../test-support/import-test-kit';
import { bannedWordsIn } from './result-model';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const result = (): HTMLElement => screen.getByTestId('import-result');
const mainText = (): string => result().textContent ?? '';
const primary = (): HTMLElement => screen.getByTestId('import-primary-action');
const primaryButtons = (): HTMLElement[] => within(result()).getAllByRole('button').filter((b) => b.className.includes('bg-ih-primary text-ih-primary-fg'));
const notFoundFor = (id: string) => (_n: number, b: Uint8Array): ApiOutcome => (idsOf(b).includes(id) ? refused(404, 'NOT_FOUND', { inspectionId: id }) : ok(b));

describe('the result page: structure', () => {
  it('everything imported: the sentence is a second-level heading, one primary action, details closed', async () => {
    await runToResult(makePackage({ inspections: 3, updates: { 0: 1 } }), (_n, b) => ok(b));
    expect(within(result()).getByRole('heading', { level: 2, name: 'All 3 inspections were imported.' })).toBeVisible();
    expect(within(result()).getByText('Your file was not changed. Delete it when you no longer need it.')).toBeVisible();
    expect(primary()).toHaveTextContent('Done');
    expect(primaryButtons()).toEqual([primary()]);
    expect(screen.queryByTestId('import-details')).toBeNull();
    expect(within(result()).queryByTestId('import-row')).toBeNull();
  });

  it('the primary action is the first control after the summary, before any list', async () => {
    await runToResult(makePackage({ inspections: 3 }), notFoundFor('insp-1'));
    const buttons = within(result()).getAllByRole('button');
    expect(buttons[0]).toBe(primary());
    const list = within(result()).getAllByTestId('import-row')[0];
    expect(primary().compareDocumentPosition(list as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a 404 for one inspection: plain sentence, the inspection by name, what to do, and no answer code in the main text', async () => {
    await runToResult(makePackage({ inspections: 3 }), notFoundFor('insp-1'));
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('2 of 3 inspections were imported. 1 was not.');
    expect(within(result()).getByText('Safe: 2 inspections are on the server now.')).toBeVisible();
    expect(within(result()).getByText('1 is not on the server.')).toBeVisible();
    const group = screen.getByTestId('import-group-not_found');
    expect(within(group).getByRole('heading', { level: 3 })).toHaveTextContent('The server could not find it in your company.');
    expect(within(group).getByTestId('import-row')).toHaveTextContent('Inspection insp-1');
    expect(primary()).toHaveTextContent('Save the 1 that was not imported');
    expect(primaryButtons()).toEqual([primary()]);
    // The one group that can be saved has no second Save beside the primary one.
    expect(within(group).queryByRole('button')).toBeNull();
    expect(mainText()).not.toMatch(/404|NOT_FOUND|not_found/);
  });

  it('Details is a real button with aria-expanded; opening it shows the server answer, closing hides it again', async () => {
    await runToResult(makePackage({ inspections: 3 }), notFoundFor('insp-1'));
    const user = userEvent.setup();
    const toggle = within(result()).getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', screen.getByTestId('import-details').id);
    expect(screen.getByTestId('import-details')).toHaveTextContent('insp-1: not_found. Server answer: 404 NOT_FOUND.');
    expect(screen.getByTestId('import-details')).toHaveTextContent('Requests sent:');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('import-details')).toBeNull();
  });

  it('an expired file names the days the server gave, and the only action is Done', async () => {
    await runToResult(makePackage({ inspections: 2 }), () => refused(422, 'PACKAGE_EXPIRED', { maxAgeDays: 30 }));
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('Nothing was imported.');
    expect(screen.getByTestId('import-group-file_expired')).toHaveTextContent('This file is more than 30 days old, so it cannot be imported.');
    expect(within(screen.getByTestId('import-group-file_expired')).getAllByTestId('import-row')).toHaveLength(2);
    expect(primary()).toHaveTextContent('Done');
    expect(primaryButtons()).toEqual([primary()]);
  });

  it('queued changes the server did not apply are listed on their own, with the code only in Details', async () => {
    const made = makePackage({ inspections: 2, updates: { 0: 1 } });
    await runToResult(made, (_n, b) => ({
      kind: 'response',
      status: 200,
      json: confirmedBody(b, { applied: 0, failed: [{ idempotencyKey: 'k-insp-0-0', op: 'inspection.update', inspectionId: 'insp-0', status: 422, reason: 'invalid' }] }),
    }));
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('All 2 inspections were imported. 1 change was not applied.');
    expect(screen.getByTestId('import-attention')).toHaveTextContent('Change to inspection insp-0');
    expect(mainText()).not.toMatch(/inspection\.update|422|invalid/);
    await userEvent.setup().click(within(result()).getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('import-details')).toHaveTextContent('inspection.update on inspection insp-0: server answer 422, reason invalid');
  });
});

describe('the result page: saving what was not imported', () => {
  it('"Save the 1 that was not imported" writes a file of just that inspection and opens the share sheet', async () => {
    const made = makePackage({ inspections: 3, photos: { 1: 1 } });
    const view = await runToResult(made, notFoundFor('insp-1'));
    await userEvent.setup().click(primary());
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    const summary = readPackageSummary(view.world.sharer.calls[0]?.bytes ?? new Uint8Array());
    expect(summary.manifest.inspections.map((i) => i.id)).toEqual(['insp-1']);
    expect(summary.counts.photos).toBe(1);
    expect(await screen.findByText(/Saved\. Choose where to keep it/)).toBeVisible();
  });

  it('control: a share sheet that fails says so in plain words and changes nothing else', async () => {
    const view = await runToResult(makePackage({ inspections: 2 }), notFoundFor('insp-1'));
    view.world.sharer.mode = 'error';
    await userEvent.setup().click(primary());
    expect(await screen.findByText('The file could not be saved. Nothing was changed. Try again.')).toBeVisible();
    expect(screen.getByTestId('import-group-not_found')).toBeVisible();
  });

  it('two taps on Save in one frame open the sheet once', async () => {
    const view = await runToResult(makePackage({ inspections: 2 }), notFoundFor('insp-1'));
    await act(async () => {
      primary().click();
      primary().click();
    });
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    expect(view.world.sharer.calls).toHaveLength(1);
  });

  it('with several groups each has its own Save, next to a single primary', async () => {
    const view = await runToResult(makePackage({ inspections: 4 }), (_n, b) => {
      const ids = idsOf(b);
      if (ids.includes('insp-1')) return refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' });
      if (ids.includes('insp-2')) return refused(409, 'PACKAGE_INSPECTION_DELETED', { inspectionId: 'insp-2', inspectionIds: ['insp-2'] });
      return ok(b);
    });
    expect(primaryButtons()).toEqual([primary()]);
    expect(primary()).toHaveTextContent('Save the 2 that were not imported');
    const group = screen.getByTestId('import-group-deleted');
    await userEvent.setup().click(within(group).getByRole('button', { name: 'Save this one' }));
    await waitFor(() => expect(view.world.sharer.calls).toHaveLength(1));
    expect(readPackageSummary(view.world.sharer.calls[0]?.bytes ?? new Uint8Array()).manifest.inspections.map((i) => i.id)).toEqual(['insp-2']);
  });
});

describe('the result page: when sending could not go on', () => {
  it.each([
    ['auth', 'These were not sent because you were signed out.', 'Try again'],
    ['locked', 'These were not sent because this device is locked.', 'Try again'],
    ['upgrade', 'These were not sent because this version of the app is too old for your server.', 'Done'],
    ['server_too_old', 'These were not sent because your server is too old for this app.', 'Done'],
  ] as const)('"%s": one sentence, nothing was uploaded, one next step', async (problem, heading, label) => {
    const view = await runToResult(makePackage({ inspections: 4 }), () => ({ kind: 'problem', problem }));
    expect(view.calls).toHaveLength(1);
    expect(within(result()).getByRole('heading', { level: 2 })).toHaveTextContent('Nothing was imported.');
    expect(within(result()).getByRole('heading', { level: 3 })).toHaveTextContent(heading);
    expect(result()).toHaveTextContent('Nothing was uploaded for them.');
    expect(within(result()).getAllByTestId('import-row')).toHaveLength(4);
    expect(primary()).toHaveTextContent(label);
    expect(primaryButtons()).toEqual([primary()]);
  });

  it('"Try again" imports the same file again, without choosing it again', async () => {
    const view = await runToResult(makePackage({ inspections: 2 }), (n, b) => (n === 1 ? { kind: 'problem', problem: 'auth' } : ok(b)));
    await userEvent.setup().click(primary());
    await waitFor(() => expect(screen.getByTestId('import-headline')).toHaveTextContent('All 2 inspections were imported.'));
    expect(view.calls).toHaveLength(2);
  });

  it('a request that lost its answer and was then cut short by the sign-in is NOT described as unsent', async () => {
    const view = await runToResult(makePackage({ inspections: 3 }), (n) => ({ kind: 'problem', problem: n === 1 ? 'offline' : 'auth' }));
    expect(view.calls).toHaveLength(2);
    const group = screen.getByTestId('import-group-no_answer');
    expect(group).toHaveTextContent('The server did not answer in time for these.');
    expect(group).toHaveTextContent('It may or may not have received them.');
    expect(group).toHaveTextContent('Trying again is safe');
    expect(group).toHaveTextContent('Sign in again first.');
    expect(mainText()).not.toMatch(/Nothing was uploaded|not sent/);
    expect(within(result()).getByText('3 may or may not be on the server.')).toBeVisible();
  });

  it('control: no answer at all ends in the retry limit and the same plain explanation', async () => {
    const view = await runToResult(makePackage({ inspections: 2 }), () => ({ kind: 'problem', problem: 'offline' }));
    expect(view.calls).toHaveLength(5);
    expect(screen.getByTestId('import-group-no_answer')).toHaveTextContent('The server did not answer in time for these.');
    expect(primary()).toHaveTextContent('Try again');
    expect(mainText()).not.toMatch(/signed out/);
  });
});

describe('the result page: plain words and design tokens in every situation', () => {
  const situations: Array<[string, Parameters<typeof makePackage>[0], Parameters<typeof runToResult>[1]]> = [
    ['all imported', { inspections: 3 }, (_n, b) => ok(b)],
    ['partial', { inspections: 3 }, notFoundFor('insp-1')],
    ['expired', { inspections: 2 }, () => refused(422, 'PACKAGE_EXPIRED', { maxAgeDays: 30 })],
    ['forbidden', { inspections: 2 }, () => refused(403, 'FORBIDDEN')],
    ['signed out', { inspections: 3 }, () => ({ kind: 'problem', problem: 'auth' })],
    ['locked', { inspections: 3 }, () => ({ kind: 'problem', problem: 'locked' })],
    ['timeout then sign-out', { inspections: 3 }, (n) => ({ kind: 'problem', problem: n === 1 ? 'offline' : 'auth' })],
    ['offline', { inspections: 2 }, () => ({ kind: 'problem', problem: 'offline' })],
  ];

  it.each(situations)('%s: no jargon, no exclamation mark, one primary action, no raw colours, no fixed sizes', async (_name, spec, respond) => {
    await runToResult(makePackage(spec), respond);
    expect(bannedWordsIn(mainText())).toEqual([]);
    expect(mainText()).not.toContain('!');
    expect(primaryButtons()).toHaveLength(1);
    expect(result().innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|(?:bg|text|border)-(?:red|green|blue|yellow|orange|gray|slate)-\d/i);
    expect(result().innerHTML).not.toMatch(/style="[^"]*(?:width|height)\s*:\s*\d+px/i);
  });
});
