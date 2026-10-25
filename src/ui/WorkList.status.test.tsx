// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReconcileOutcome } from '../offline/reconciler';
import { renderList, withOutcome, withStatus } from './test-support/worklist-render';
import { at, createListWorld, NOW, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
});
afterEach(cleanup);

const region = () => screen.findByRole('region', { name: 'Server check' });

async function show(patch: Partial<ReconcileOutcome>) {
  const stack = withOutcome(w.stack, patch);
  renderList(stack);
  await screen.findByTestId('row-a');
  return stack;
}

describe('reconcile status', () => {
  it('massSuspicious: a prominent amber warning that nothing was removed', async () => {
    await show({ massSuspicious: true });
    const note = within(await region()).getByText('The server did not list many of your inspections. Nothing was removed automatically. Check your connection and account, then try again.');
    expect(note.closest('[role="status"]')?.className).toContain('bg-ih-watch-bg');
  });

  it('allMissing with several inspections: the server lost track of all of them, nothing removed', async () => {
    await show({ allMissing: true, candidateCount: 4, massSuspicious: true });
    const area = await region();
    expect(within(area).getByText(/The server lost track of all of your inspections\./)).toHaveTextContent('Nothing was removed.');
    expect(within(area).queryByText(/did not list many/)).toBeNull();
  });

  it('allMissing with a single inspection uses the single-inspection wording', async () => {
    await show({ allMissing: true, candidateCount: 1 });
    expect(within(await region()).getByText('This inspection is no longer on your list. Nothing was removed automatically.')).toBeInTheDocument();
  });

  it('unavailableRole: a quiet note, not an alert', async () => {
    await show({ unavailableRole: true, status: 'unavailable' });
    const note = within(await region()).getByText('Cleanup of removed inspections is not available for your role.');
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refusedNullInspectionId: points at the queued changes to review', async () => {
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: null });
    await show({ refusedNullInspectionId: true, status: 'refused', reason: 'null_inspection_id' });
    expect(within(await region()).getByText('A queued change could not be matched to an inspection. Review the queued changes below.')).toBeInTheDocument();
    const review = within(await region()).getByRole('button', { name: 'Review queued changes' });
    await userEvent.setup().click(review);
    expect(await screen.findByRole('heading', { name: 'Queued changes to review' })).toHaveFocus();
  });

  it.each([
    ['failed', 'Could not check the server for removed inspections. Nothing was removed.'],
    ['error', 'Could not check the server for removed inspections. Nothing was removed.'],
  ] as const)('status %s says nothing was removed', async (status, text) => {
    await show({ status });
    expect(within(await region()).getByText(text)).toBeInTheDocument();
  });

  it('a clean outcome says when it last checked and shows no warning', async () => {
    await show({ status: 'done', at: NOW - 120_000 });
    const area = await region();
    expect(within(area).getByText('Checked 2 minutes ago')).toBeInTheDocument();
    expect(within(area).queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/did not list many/)).toBeNull();
  });

  it('before the first check it says so', async () => {
    await show({ status: 'never', at: null });
    expect(within(await region()).getByText('Not checked yet')).toBeInTheDocument();
  });

  it('Check now asks the reconciler once for a manual flow, even for two taps in a frame', async () => {
    const stack = await show({});
    const button = within(await region()).getByRole('button', { name: 'Check now' });
    button.click();
    button.click();
    await waitFor(() => expect(stack.trigger).toHaveBeenCalled());
    expect(stack.trigger).toHaveBeenCalledExactlyOnceWith('manual');
    expect(await screen.findByText('Check requested.')).toBeInTheDocument();
  });
});

describe('status strip', () => {
  type Flags = Partial<{ auth: boolean; upgrade: boolean; editsNotSaved: boolean; collabIssue: boolean }>;

  function open(initial: Flags) {
    const held = withStatus(w.stack, initial);
    renderList(held.stack);
    return {
      patch: (flags: Flags) => {
        act(() => {
          held.status.patch(flags);
        });
      },
    };
  }

  it('auth: sign in again to keep syncing', async () => {
    open({ auth: true });
    expect(await screen.findByText('Sign in again to keep syncing')).toBeInTheDocument();
  });

  it('upgrade: update the app, with no link and no server text', async () => {
    open({ upgrade: true });
    const note = await screen.findByText('Update the app to keep syncing');
    expect(note.closest('[role="status"]')?.querySelector('a')).toBeNull();
  });

  it('editsNotSaved: a persistent red alert', async () => {
    open({ editsNotSaved: true });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Some edits may not be saved on this device. Free up storage and restart the app.');
    expect(alert.className).toContain('bg-ih-bad-bg');
  });

  it('collabIssue: a quiet line, not an alert', async () => {
    open({ collabIssue: true });
    expect(await screen.findByText('Live collaboration is having trouble. Your changes are still stored on this device.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing when the stack reports nothing, and follows a change while open', async () => {
    const { patch } = open({});
    await screen.findByTestId('row-a');
    expect(screen.queryByText('Sign in again to keep syncing')).toBeNull();
    patch({ auth: true });
    expect(await screen.findByText('Sign in again to keep syncing')).toBeInTheDocument();
    patch({ auth: false });
    await waitFor(() => expect(screen.queryByText('Sign in again to keep syncing')).toBeNull());
  });
});
