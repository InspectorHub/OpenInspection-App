// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import { renderList, withOutcome } from './test-support/worklist-render';
import { watchUnhandled, type UnhandledWatch } from './test-support/unhandled';
import { at, createListWorld, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;
let watch: UnhandledWatch;

const SECRET = 'boom-secret-detail';

beforeEach(async () => {
  w = await createListWorld();
  watch = watchUnhandled();
});
afterEach(async () => {
  await watch.finish();
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

/** After the action: nothing escaped as an unhandled rejection, and nothing of the error's text is on the screen. */
async function expectContained(): Promise<void> {
  expect(await watch.finish()).toEqual([]);
  expect(document.body.textContent).not.toContain(SECRET);
}

const boom = () => Promise.reject(new Error(SECRET));

describe('a throwing port never becomes an unhandled rejection, and its text is never shown', () => {
  it('Retry of a queued change', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'rejected' });
    vi.spyOn(w.stack.replayer, 'retry').mockImplementation(boom);
    renderList(w.stack);
    const area = await screen.findByRole('region', { name: 'Needs attention' });
    await userEvent.setup().click(within(area).getByRole('button', { name: /^Retry/ }));
    expect(await within(area).findByRole('alert')).toHaveTextContent('Could not retry. Try again.');
    await expectContained();
  });

  it('Retry of a photo', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedMedia(w.db, 'm1', 'a', 'failed');
    vi.spyOn(w.stack.uploader, 'retry').mockImplementation(boom);
    renderList(w.stack);
    const area = await screen.findByRole('region', { name: 'Needs attention' });
    await userEvent.setup().click(within(area).getByRole('button', { name: /^Retry/ }));
    expect(await within(area).findByRole('alert')).toHaveTextContent('Could not retry. Try again.');
    await expectContained();
  });

  it('a Retry that works again afterwards clears the line', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'rejected' });
    const retry = vi.spyOn(w.stack.replayer, 'retry').mockImplementationOnce(boom).mockResolvedValue(true);
    renderList(w.stack);
    const area = await screen.findByRole('region', { name: 'Needs attention' });
    const user = userEvent.setup();
    await user.click(within(area).getByRole('button', { name: /^Retry/ }));
    await within(area).findByRole('alert');
    await user.click(within(area).getByRole('button', { name: /^Retry/ }));
    expect(retry).toHaveBeenCalledTimes(2);
    expect(within(area).queryByRole('alert')).toBeNull();
    await expectContained();
  });

  it('Discard of a queued change', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'rejected' });
    vi.spyOn(w.stack.replayer, 'discard').mockImplementation(boom);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Needs attention' })).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Could not discard this change. Try again.');
    await expectContained();
  });

  it('Discard of a stuck photo of a quarantined inspection', async () => {
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedMedia(w.db, 'm1', 'q', 'failed');
    vi.spyOn(w.stack.userActions, 'discardMedia').mockImplementation(boom);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Needs attention' })).getByRole('button', { name: /^Discard photo, / }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Could not discard this change. Try again.');
    await expectContained();
  });

  it('Discard of an orphan photo', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedMedia(w.db, 'ghostly', 'ghost0000', 'failed');
    vi.spyOn(w.stack.userActions, 'discardMedia').mockImplementation(boom);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Orphan photos on this device' })).getByRole('button', { name: 'Discard orphan photo' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Could not discard this change. Try again.');
    await expectContained();
  });

  it('Discard of a queued change that names no inspection', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'u1', seq: 1, inspectionId: null, state: 'failed', error: 'rejected' });
    vi.spyOn(w.stack.userActions, 'discardOutboxRow').mockImplementation(boom);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Queued changes to review' })).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Could not discard this change. Try again.');
    await expectContained();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error(SECRET))],
    [
      'throws at once',
      () => {
        throw new Error(SECRET);
      },
    ],
  ])('Copy when the clipboard %s', async (_name, writeText) => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'u1', seq: 1, inspectionId: null, state: 'failed', error: 'rejected' });
    renderList(w.stack);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(within(await screen.findByRole('region', { name: 'Queued changes to review' })).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    await user.click(within(copy).getByRole('button', { name: 'Copy' }));
    expect(await within(copy).findByText('Could not copy. Select the text and copy it by hand.')).toBeInTheDocument();
    await expectContained();
  });

  it('Pin', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    const row = await screen.findByTestId('row-a');
    vi.spyOn(w.db, 'run').mockImplementation(boom);
    await userEvent.setup().click(within(row).getByRole('button', { name: /^Pin/ }));
    expect(await screen.findByText('This inspection cannot be pinned right now.')).toBeInTheDocument();
    await expectContained();
  });

  it("Download today's work", async () => {
    vi.spyOn(w.stack.refresher, 'refresh').mockImplementation(boom);
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', { name: "Download today's work" }));
    expect(await screen.findByText('The download did not finish. Try again.')).toBeInTheDocument();
    await expectContained();
  });

  it('Check now when the reconciler throws', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const stack = withOutcome(w.stack, {});
    stack.trigger.mockImplementation(() => {
      throw new Error(SECRET);
    });
    renderList(stack as OfflineStack);
    await screen.findByTestId('row-a');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Could not start the check. Try again.')).toBeInTheDocument();
    await expectContained();
  });

  it('Remove', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    const stack: OfflineStack = { ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(boom) } };
    renderList(stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId('row-q1')).getByRole('button', { name: /^Remove .+ from this device$/ }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(/Edits on this device/);
    await user.click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not remove everything. Nothing else was changed. Try again.');
    await expectContained();
  });

  it('Discard and remove, when the discard of the create throws', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedQueued(w.db, { key: 'c1', seq: 1, inspectionId: 'mine00001', state: 'failed', error: 'rejected', op: 'inspection.create' });
    vi.spyOn(w.stack.replayer, 'discard').mockImplementation(boom);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Needs attention' })).getByRole('button', { name: /^Discard and remove/ }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(/Queued changes/);
    await user.click(within(dialog).getByRole('button', { name: 'Discard and remove this inspection from this device' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not remove everything. Nothing else was changed. Try again.');
    expect(await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['mine00001'])).toHaveLength(1);
    await expectContained();
  });
});
