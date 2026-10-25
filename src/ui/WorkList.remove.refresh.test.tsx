// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import type { RemoveOutcome } from '../offline/user-actions';
import { issuePlanForTest } from '../offline/test-support/brands';
import { renderList, withOutcome } from './test-support/worklist-render';
import { ALICE, at, createListWorld, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REMOVE = { name: 'Remove from this device' };
const ROW_REMOVE = { name: /^Remove .+ from this device$/ };

async function openDialog(id: string): Promise<HTMLElement> {
  const row = await screen.findByTestId(`row-${id}`);
  await userEvent.setup().click(within(row).getByRole('button', ROW_REMOVE));
  const dialog = await screen.findByRole('alertdialog');
  await within(dialog).findByText(/Edits on this device/);
  return dialog;
}

function stackRemoving(outcome: RemoveOutcome): OfflineStack {
  return { ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(() => Promise.resolve(outcome)) } };
}

describe('Remove dialog: a refused removal shows what is true now', () => {
  it('a plan that went stale: the confirmation is refused, and the counts include the write that arrived after the dialog opened', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const plan = issuePlanForTest({
      kind: 'plan',
      purge: [],
      quarantine: ['a'],
      unquarantine: [],
      keep: [],
      deferred: [],
      unknownOwner: [],
      massSuspicious: true,
      allMissing: true,
      candidateCount: 1,
      account: ALICE,
      decidedAt: w.world.replay.clock.now(),
      fingerprints: { a: 'old' },
      reasons: { a: ['mass_suspicious'] },
      proof: { candidates: 1, requests: 1, visible: 0, missing: 1, excluded: { invalidId: 0, purging: 0, unconfirmed: 0, createPending: 0, unknownOwner: 0 }, truncated: false, unsent: {}, convertedToQuarantine: 1 },
    });
    renderList(withOutcome({ ...w.stack, lastPlan: () => plan }, { allMissing: true, candidateCount: 1 }), { now: () => w.world.replay.clock.now() });
    const row = await screen.findByTestId('row-a');
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: /No longer on the server/ }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 0');

    await seedQueued(w.db, { key: 'k9', seq: 9, inspectionId: 'a' });
    await user.click(within(dialog).getByRole('button', REMOVE));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This inspection changed since it was checked. Review it and try again.');
    await within(dialog).findByText('Queued changes: 1');
    expect((await w.db.query('SELECT inspection_id FROM work_package')).length).toBe(1);
  });

  it.each<[string, RemoveOutcome]>([
    ['busy', { kind: 'busy' }],
    ['locked', { kind: 'locked' }],
    ['lease_lost', { kind: 'lease_lost' }],
    ['unsent_now', { kind: 'unsent_now', reasons: ['outbox_pending'] }],
    ['deferred', { kind: 'deferred', reason: 'open_in_editor' }],
    ['refused changed', { kind: 'refused', reason: 'changed' }],
    ['failed interrupted', { kind: 'failed', step: 'files', code: 'interrupted' }],
    ['failed storage', { kind: 'failed', step: 'cache', code: 'storage_failed' }],
  ])('after %s the counts are read again', async (_name, outcome) => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(stackRemoving(outcome));
    const dialog = await openDialog('q1');
    expect(within(dialog).getByText('Queued changes: 0')).toBeInTheDocument();
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'q1' });
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'q1', state: 'failed', error: 'rejected' });
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await within(dialog).findByRole('alert');
    await within(dialog).findByText('Queued changes: 2');
  });

  it('the list behind the dialog is read again too', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(stackRemoving({ kind: 'busy' }));
    const dialog = await openDialog('q1');
    expect(screen.queryByText(/queued changes? (is|are) on hold because this inspection is no longer on your list/)).toBeNull();
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'q1', state: 'orphaned', error: 'target_gone' });
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await within(dialog).findByRole('alert');
    expect(await screen.findByText('1 queued change is on hold because this inspection is no longer on your list')).toBeInTheDocument();
  });

  it('control: a removal that succeeds closes the dialog and reads nothing more', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const dialog = await openDialog('q1');
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('Removed from this device.')).toBeInTheDocument();
  });
});

describe('Remove dialog: an inspection that can no longer be removed closes the dialog with a fixed line', () => {
  it('it was un-quarantined meanwhile', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(stackRemoving({ kind: 'refused', reason: 'not_quarantined' }));
    const dialog = await openDialog('q1');
    await w.db.run('UPDATE work_package SET quarantine_source = NULL WHERE inspection_id = ?', ['q1']);
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('This inspection can no longer be removed from here. Check the list.')).toBeInTheDocument();
  });

  it('it is gone from the device', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(stackRemoving({ kind: 'refused', reason: 'no_package' }));
    const dialog = await openDialog('q1');
    await w.db.run('DELETE FROM work_package WHERE inspection_id = ?', ['q1']);
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('This inspection is no longer on this device.')).toBeInTheDocument();
  });

  it('a removal that stopped halfway leaves a tombstone: it says the removal will finish on its own', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(stackRemoving({ kind: 'failed', step: 'files', code: 'interrupted' }));
    const dialog = await openDialog('q1');
    await w.db.run('UPDATE work_package SET purging = 2 WHERE inspection_id = ?', ['q1']);
    await userEvent.setup().click(within(dialog).getByRole('button', REMOVE));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('This inspection is being removed. It will finish on its own.')).toBeInTheDocument();
  });
});
