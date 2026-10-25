// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import type { ReconcilePlan } from '../offline/reconcile-decision';
import type { RemoveOutcome } from '../offline/user-actions';
import { issuePlanForTest } from '../offline/test-support/brands';
import { renderList, withOutcome } from './test-support/worklist-render';
import { ALICE, at, createListWorld, NOW, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

const ROW_REMOVE = { name: /^Remove .+ from this device$/ };
const SUSPICIOUS_REMOVE = { name: /^No longer on the server — remove .+ from this device$/ };
const DIALOG_REMOVE = { name: 'Remove from this device' };

function planNaming(id: string, patch: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return issuePlanForTest({
    kind: 'plan',
    purge: [],
    quarantine: [id],
    unquarantine: [],
    keep: [],
    deferred: [],
    unknownOwner: [],
    massSuspicious: true,
    allMissing: true,
    candidateCount: 1,
    account: ALICE,
    decidedAt: NOW,
    fingerprints: { [id]: 'fingerprint' },
    reasons: { [id]: ['mass_suspicious'] },
    proof: { candidates: 1, requests: 1, visible: 0, missing: 1, excluded: { invalidId: 0, purging: 0, unconfirmed: 0, createPending: 0, unknownOwner: 0 }, truncated: false, unsent: {}, convertedToQuarantine: 1 },
    ...patch,
  });
}

function stackWith(remove: (id: string, options: { confirmed: true; plan?: ReconcilePlan }) => Promise<RemoveOutcome>, extra: Partial<OfflineStack> = {}): OfflineStack {
  return { ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(remove) }, ...extra };
}

async function openDialog(id: string, name = ROW_REMOVE): Promise<HTMLElement> {
  const row = await screen.findByTestId(`row-${id}`);
  await userEvent.setup().click(within(row).getByRole('button', name));
  return screen.findByRole('alertdialog');
}

const confirmButton = (dialog: HTMLElement): HTMLElement => within(dialog).getByRole('button', DIALOG_REMOVE);

describe('Remove dialog: what it shows', () => {
  it('names the action, says it cannot be undone, and moves focus into the dialog', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const dialog = await openDialog('q1');
    expect(dialog).toHaveAccessibleName('Remove this inspection from this device?');
    expect(dialog).toHaveAccessibleDescription(/This cannot be undone\./);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('shows the CURRENT counts, read when the dialog opens, not when the list was last read', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    await screen.findByTestId('row-q1');
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'q1' });
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'q1', state: 'failed', error: 'rejected' });
    await seedMedia(w.db, 'm1', 'q1', 'pending');
    await seedMedia(w.db, 'm2', 'q1', 'failed');
    await seedMedia(w.db, 'm3', 'q1', 'uploaded');
    await w.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-q1', new Uint8Array([1, 2, 3])]);
    const dialog = await openDialog('q1');
    expect(await within(dialog).findByText('Edits on this device that are not on the server: Yes')).toBeInTheDocument();
    expect(within(dialog).getByText('Photos and clips waiting to upload: 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Queued changes: 2')).toBeInTheDocument();
  });

  it('says No when there are no unsent edits, and lists nothing that is not there', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const dialog = await openDialog('q1');
    expect(await within(dialog).findByText('Edits on this device that are not on the server: No')).toBeInTheDocument();
    expect(within(dialog).getByText('Photos and clips waiting to upload: 0')).toBeInTheDocument();
    expect(within(dialog).queryByText(/created on this device/i)).toBeNull();
  });

  it('flags an inspection created on this device and never sent', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing', confirmed: 0 });
    renderList(w.stack);
    const dialog = await openDialog('q1');
    expect(await within(dialog).findByText('Created on this device and never sent: Yes')).toBeInTheDocument();
  });

  it('cannot be confirmed until the counts are known; if they cannot be read it says so and stays unconfirmable', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const row = await screen.findByTestId('row-q1');
    vi.spyOn(w.db, 'transaction').mockRejectedValue(new Error('db says: private detail'));
    await userEvent.setup().click(within(row).getByRole('button', ROW_REMOVE));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText('Could not check what is on this device. Close this and try again.')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('private detail');
    expect(confirmButton(dialog)).toBeDisabled();
  });

  it('Escape closes it and hands focus back to the row button', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const row = await screen.findByTestId('row-q1');
    const trigger = within(row).getByRole('button', ROW_REMOVE);
    await openDialog('q1');
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('the confirm button is destructive-styled by token', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    expect(confirmButton(dialog).className).toContain('bg-ih-bad');
  });
});

describe('Remove dialog: when it is offered', () => {
  it('never for a healthy row, even with a plan that names another inspection', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const stack = stackWith(() => Promise.resolve({ kind: 'purged' }), { lastPlan: () => planNaming('other') });
    renderList(withOutcome(stack, { allMissing: true, candidateCount: 1 }));
    const row = await screen.findByTestId('row-a');
    expect(within(row).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('never for a healthy row when the plan is stale', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const stack = stackWith(() => Promise.resolve({ kind: 'purged' }), { lastPlan: () => planNaming('a', { decidedAt: NOW - 10 * 60_000 }) });
    renderList(withOutcome(stack, { allMissing: true, candidateCount: 1 }));
    expect(within(await screen.findByTestId('row-a')).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('never for a healthy row when the answer was not suspicious', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const stack = stackWith(() => Promise.resolve({ kind: 'purged' }), { lastPlan: () => planNaming('a', { massSuspicious: false }) });
    renderList(withOutcome(stack, {}));
    expect(within(await screen.findByTestId('row-a')).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('a healthy row the latest suspicious plan names gets the explicit action, with its own label', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const stack = stackWith(() => Promise.resolve({ kind: 'purged' }), { lastPlan: () => planNaming('a') });
    renderList(withOutcome(stack, { allMissing: true, candidateCount: 1 }));
    const row = await screen.findByTestId('row-a');
    expect(within(row).getByRole('button', SUSPICIOUS_REMOVE)).toBeInTheDocument();
  });
});

describe('Remove dialog: the call', () => {
  it('passes the EXACT plan object by reference when the plan names the inspection, and confirmed: true', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const plan = planNaming('a');
    const remove = vi.fn((): Promise<RemoveOutcome> => Promise.resolve({ kind: 'purged' }));
    const stack = withOutcome({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: remove }, lastPlan: () => plan }, { allMissing: true, candidateCount: 1 });
    renderList(stack);
    const dialog = await openDialog('a', SUSPICIOUS_REMOVE);
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const [id, options] = remove.mock.calls[0] as unknown as [string, { confirmed: true; plan?: ReconcilePlan }];
    expect(id).toBe('a');
    expect(options.confirmed).toBe(true);
    expect(options.plan).toBe(plan);
    expect(Object.isFrozen(options.plan)).toBe(Object.isFrozen(plan));
  });

  it('a quarantined row that no plan names is removed without a plan', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    const remove = vi.fn((): Promise<RemoveOutcome> => Promise.resolve({ kind: 'purged' }));
    renderList({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: remove } });
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const options = (remove.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(options).toEqual({ confirmed: true });
    expect('plan' in options).toBe(false);
  });

  it('two taps in one frame send one call, and the dialog is busy meanwhile', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    let release: (outcome: RemoveOutcome) => void = () => undefined;
    const remove = vi.fn(() => new Promise<RemoveOutcome>((resolve) => (release = resolve)));
    renderList({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: remove } });
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    const confirm = confirmButton(dialog);
    confirm.click();
    confirm.click();
    await waitFor(() => expect(confirmButton(screen.getByRole('alertdialog'))).toBeDisabled());
    expect(remove).toHaveBeenCalledTimes(1);
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    release({ kind: 'purged' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

describe('Remove dialog: every result has a fixed message', () => {
  const FAILURES: [string, RemoveOutcome, string][] = [
    ['locked', { kind: 'locked' }, 'The app is locked. Verify online first.'],
    ['busy', { kind: 'busy' }, 'Another sync step is running. Try again in a moment.'],
    ['lease_lost', { kind: 'lease_lost' }, 'Another sync step took over. Nothing was lost. Try again in a moment.'],
    ['deferred', { kind: 'deferred', reason: 'open_in_editor' }, 'Close the inspection first, then try again.'],
    ['unsent_now', { kind: 'unsent_now', reasons: ['outbox_pending'] }, 'New unsent data appeared. Check the counts and try again.'],
    ['failed', { kind: 'failed', step: 'files', code: 'file_remove_failed' }, 'Could not remove everything. Nothing else was changed. Try again.'],
    ['failed foreign_outbox', { kind: 'failed', step: 'outbox', code: 'foreign_outbox' }, 'A queued change of another account is stored for this inspection. That account has to sign in to deal with it.'],
    ['failed interrupted', { kind: 'failed', step: 'cache', code: 'interrupted' }, 'The removal was interrupted. Try again to finish it.'],
    ['refused plan_not_issued', { kind: 'refused', reason: 'plan_not_issued' }, 'This action is not available right now. Check again, then try once more.'],
    ['refused not_authorized', { kind: 'refused', reason: 'not_authorized' }, 'This action is not available right now. Check again, then try once more.'],
    ['refused not_quarantined', { kind: 'refused', reason: 'not_quarantined' }, 'This inspection is still on your list, so it cannot be removed.'],
    ['refused no_account', { kind: 'refused', reason: 'no_account' }, 'Sign in again to continue.'],
    ['refused not_owner', { kind: 'refused', reason: 'not_owner' }, 'This inspection belongs to another account on this device.'],
    ['refused no_package', { kind: 'refused', reason: 'no_package' }, 'This inspection is no longer on this device.'],
    ['refused changed', { kind: 'refused', reason: 'changed' }, 'This inspection changed since it was checked. Review it and try again.'],
    ['refused create_pending', { kind: 'refused', reason: 'create_pending' }, 'A new inspection made on this device has not been sent yet.'],
    ['refused unattributable', { kind: 'refused', reason: 'unattributable' }, 'A queued change is not linked to an inspection. Review the queued changes first.'],
    ['refused invalid_id', { kind: 'refused', reason: 'invalid_id' }, 'This action could not be carried out.'],
  ];

  it.each(FAILURES)('%s', async (_name, outcome, text) => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(() => Promise.resolve(outcome)) } });
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    const alert = await within(await screen.findByRole('alertdialog')).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    // The dialog stays open, so the person can try again or close it, and the button works again.
    expect(confirmButton(screen.getByRole('alertdialog'))).toBeEnabled();
  });

  it('a call that throws shows the fixed retry hint and nothing from the error', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(() => Promise.reject(new Error('token=abc123'))) } });
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    const alert = await within(await screen.findByRole('alertdialog')).findByRole('alert');
    expect(alert).toHaveTextContent('Could not remove everything. Nothing else was changed. Try again.');
    expect(alert.textContent).not.toContain('abc123');
  });

  it('purged closes the dialog, says so, and reads the list again', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    const remove = vi.fn(async (): Promise<RemoveOutcome> => {
      await w.db.run("DELETE FROM work_package WHERE inspection_id = 'q1'");
      return { kind: 'purged' };
    });
    renderList({ ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: remove } });
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('Removed from this device.')).toBeInTheDocument();
    expect(screen.queryByTestId('row-q1')).toBeNull();
  });
});

describe('Remove dialog: the real removal', () => {
  it('removes a quarantined inspection with its queued writes and photos, and leaves another inspection alone', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedPkg(w.db, { id: 'keep', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'q1', state: 'orphaned', error: 'target_gone' });
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'keep' });
    await seedMedia(w.db, 'm1', 'q1', 'failed');
    renderList(w.stack);
    const dialog = await openDialog('q1');
    await within(dialog).findByText(/Edits on this device/);
    await userEvent.setup().click(confirmButton(dialog));
    await waitFor(() => expect(screen.queryByTestId('row-q1')).toBeNull());
    expect(screen.getByTestId('row-keep')).toBeInTheDocument();
    const left = await w.db.query<{ inspection_id: string | null }>('SELECT inspection_id FROM outbox');
    expect(left.map((r) => r.inspection_id)).toEqual(['keep']);
    expect((await w.db.query('SELECT 1 FROM media')).length).toBe(0);
  });
});
