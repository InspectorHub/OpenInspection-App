// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedCached, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rowOf = (id: string): Promise<HTMLElement> => screen.findByTestId(`row-${id}`);
const heading = (): HTMLElement => screen.getByRole('heading', { level: 1, name: 'Work list' });

describe('every row button has a name that says which inspection it is for', () => {
  it('Remove, Pin and Unpin carry the short title, and the visible text is unchanged', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedCached(w.db, 'a', '12 Elm St');
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedCached(w.db, 'q', '7 Mill Lane');
    renderList(w.stack);
    const healthy = await rowOf('a');
    const pin = within(healthy).getByRole('button', { name: 'Pin 12 Elm St' });
    expect(pin).toHaveTextContent(/^Pin$/);
    await userEvent.setup().click(pin);
    const unpin = await within(screen.getByTestId('row-a')).findByRole('button', { name: 'Unpin 12 Elm St' });
    expect(unpin).toHaveTextContent(/^Pin$/);
    const remove = within(await rowOf('q')).getByRole('button', { name: 'Remove 7 Mill Lane from this device' });
    expect(remove).toHaveTextContent(/^Remove from this device$/);
  });

  it('the row that a suspicious answer named keeps its own wording, with the title in it', async () => {
    await seedPkg(w.db, { id: 'n', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedCached(w.db, 'n', '9 Oak Ave');
    renderList(w.stack);
    expect(within(await rowOf('n')).getByRole('button', { name: /^Remove 9 Oak Ave from this device$/ })).toBeInTheDocument();
  });

  it('a stuck photo or clip: Retry and Discard both name the inspection', async () => {
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedCached(w.db, 'q', '7 Mill Lane');
    await seedMedia(w.db, 'm1', 'q', 'failed');
    renderList(w.stack);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    const retry = within(panel).getByRole('button', { name: 'Retry photo, 7 Mill Lane' });
    expect(retry).toHaveTextContent(/^Retry$/);
    const discard = within(panel).getByRole('button', { name: 'Discard photo, 7 Mill Lane' });
    expect(discard).toHaveTextContent(/^Discard photo$/);
  });

  it('a failed queued change: Retry and Discard name the change and the inspection', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedCached(w.db, 'a', '12 Elm St');
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'validation_failed', op: 'inspection.update' });
    renderList(w.stack);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(panel).getByRole('button', { name: 'Retry Inspection edit, 12 Elm St' })).toHaveTextContent(/^Retry$/);
    expect(within(panel).getByRole('button', { name: 'Discard Inspection edit, 12 Elm St' })).toHaveTextContent(/^Discard…$/);
  });
});

describe('focus returns to the button that opened a dialog', () => {
  async function openFromPanel(label: RegExp): Promise<{ opener: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
    const user = userEvent.setup();
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    const opener = within(panel).getByRole('button', { name: label });
    await user.click(opener);
    await screen.findByRole('alertdialog');
    return { opener, user };
  }

  beforeEach(async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'validation_failed', op: 'inspection.update' });
  });

  it('a failed change: Cancel', async () => {
    renderList(w.stack);
    const { opener, user } = await openFromPanel(/^Discard/);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a failed change: Escape', async () => {
    renderList(w.stack);
    const { opener, user } = await openFromPanel(/^Discard/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a failed change: after the discard succeeds the row is gone, so focus goes to the list heading', async () => {
    renderList(w.stack);
    const { opener, user } = await openFromPanel(/^Discard/);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(opener.isConnected).toBe(false));
    expect(document.activeElement).toBe(heading());
  });

  it('a stuck photo of a quarantined inspection: Cancel', async () => {
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedMedia(w.db, 'm1', 'q', 'failed');
    renderList(w.stack);
    const { opener, user } = await openFromPanel(/^Discard photo/);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
  });

  it('a failed create: Cancel on the discard-and-remove dialog', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedQueued(w.db, { key: 'c1', seq: 5, inspectionId: 'mine00001', state: 'failed', error: 'rejected', op: 'inspection.create' });
    renderList(w.stack);
    const { opener, user } = await openFromPanel(/^Discard and remove this inspection from this device/);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a failed create: after the removal succeeds focus goes to the list heading', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedQueued(w.db, { key: 'c1', seq: 5, inspectionId: 'mine00001', state: 'failed', error: 'rejected', op: 'inspection.create' });
    renderList(w.stack);
    const { user } = await openFromPanel(/^Discard and remove this inspection from this device/);
    const dialog = screen.getByRole('alertdialog');
    await within(dialog).findByText(/^Queued changes: /);
    await user.click(within(dialog).getByRole('button', { name: 'Discard and remove this inspection from this device' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('row-mine00001')).toBeNull());
    expect(document.activeElement).toBe(heading());
  });

  it('a queued change that names no inspection (the review panel): Escape', async () => {
    await seedQueued(w.db, { key: 'u1', seq: 9, inspectionId: null, state: 'failed', error: 'corrupt_payload', op: 'inspection.update' });
    renderList(w.stack);
    const user = userEvent.setup();
    const panel = await screen.findByRole('region', { name: 'Queued changes to review' });
    const opener = within(panel).getByRole('button', { name: /^Discard/ });
    await user.click(opener);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('the row Remove dialog: Cancel and Escape go back to the row button, success goes to the heading', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const user = userEvent.setup();
    const opener = within(await rowOf('q1')).getByRole('button', { name: /^Remove .+ from this device$/ });
    await user.click(opener);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(/Edits on this device/);
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    await waitFor(() => expect(screen.queryByTestId('row-q1')).toBeNull());
    expect(document.activeElement).toBe(heading());
  });
});
