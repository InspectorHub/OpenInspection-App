// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import { OUTBOX_ERROR_CODES } from '../platform/schema';
import type { DiscardMediaOutcome, DiscardOutboxOutcome } from '../offline/user-actions';
import { OUTBOX_ERROR_TEXT } from './worklist/copy';
import { renderList } from './test-support/worklist-render';
import { at, BOB, createListWorld, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

const panel = () => screen.findByRole('region', { name: 'Needs attention' });
const repair = () => screen.findByRole('region', { name: 'Queued changes to review' });

describe('error text', () => {
  it('has a fixed text for every outbox error code, and no other keys', () => {
    expect(Object.keys(OUTBOX_ERROR_TEXT).sort()).toEqual([...OUTBOX_ERROR_CODES].sort());
    for (const code of OUTBOX_ERROR_CODES) {
      expect(OUTBOX_ERROR_TEXT[code].length).toBeGreaterThan(10);
      expect(OUTBOX_ERROR_TEXT[code]).not.toContain('_');
    }
  });
});

describe('Needs attention: failed queued changes', () => {
  beforeEach(async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'validation_failed', payload: '{"note":"héllo"}', op: 'inspection.update' });
  });

  it('lists the change under its inspection with a fixed explanation and its size', async () => {
    renderList(w.stack);
    const area = await panel();
    expect(within(area).getByText('Inspection edit')).toBeInTheDocument();
    expect(within(area).getByText(OUTBOX_ERROR_TEXT.validation_failed)).toBeInTheDocument();
    expect(within(area).getByText('17 bytes')).toBeInTheDocument();
  });

  it('a failed row with no readable code gets a generic fixed line', async () => {
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'a', state: 'failed', error: '<b>server wording</b>', op: 'something.else' });
    renderList(w.stack);
    const area = await panel();
    expect(within(area).getByText('This change could not be sent.')).toBeInTheDocument();
    expect(within(area).getByText('Queued change')).toBeInTheDocument();
    expect(area).not.toHaveTextContent('server wording');
  });

  it('Retry puts the change back in line through the replayer', async () => {
    const retry = vi.spyOn(w.stack.replayer, 'retry').mockResolvedValue(true);
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Retry/ }));
    expect(retry).toHaveBeenCalledExactlyOnceWith('k1');
  });

  it('two Retry taps in one frame call once', async () => {
    const retry = vi.spyOn(w.stack.replayer, 'retry').mockResolvedValue(true);
    renderList(w.stack);
    const button = within(await panel()).getByRole('button', { name: /^Retry/ });
    button.click();
    button.click();
    await waitFor(() => expect(retry).toHaveBeenCalled());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('Discard asks first, says the change will be permanently removed with its size, and sends nothing until confirmed', async () => {
    const discard = vi.spyOn(w.stack.replayer, 'discard').mockResolvedValue(true);
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Discard/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard this queued change?');
    expect(dialog).toHaveAccessibleDescription(/The queued change will be permanently removed \(17 bytes\)\. This cannot be undone\./);
    expect(discard).not.toHaveBeenCalled();
  });

  it('Cancel leaves it queued', async () => {
    const discard = vi.spyOn(w.stack.replayer, 'discard').mockResolvedValue(true);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await panel()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('confirming discards once with confirmed: true, even for two taps in a frame, and reads the list again', async () => {
    const discard = vi.spyOn(w.stack.replayer, 'discard').mockImplementation(async (key) => {
      await w.db.run('DELETE FROM outbox WHERE idempotency_key = ?', [key]);
      return true;
    });
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Discard/ }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(discard).toHaveBeenCalledExactlyOnceWith('k1', { confirmed: true });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull());
  });

  it('a discard that finds nothing says so and stays open', async () => {
    vi.spyOn(w.stack.replayer, 'discard').mockResolvedValue(false);
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Discard/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Discard change' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Could not discard this change. It may already be gone.');
  });

  it('the panel is absent when nothing failed', async () => {
    await w.db.run('DELETE FROM outbox');
    renderList(w.stack);
    await screen.findByTestId('row-a');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
  });
});

describe('Needs attention: stuck photos', () => {
  it('Retry goes to the uploader', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedMedia(w.db, 'm1', 'a', 'failed');
    const retry = vi.spyOn(w.stack.uploader, 'retry').mockResolvedValue(true);
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Retry/ }));
    expect(retry).toHaveBeenCalledExactlyOnceWith('m1');
  });

  it('a photo of a healthy inspection cannot be discarded from the list', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedMedia(w.db, 'm1', 'a', 'failed');
    renderList(w.stack);
    expect(within(await panel()).queryByRole('button', { name: /^Discard/ })).toBeNull();
  });

  it('a photo of a quarantined inspection can be discarded after a confirmation', async () => {
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedMedia(w.db, 'm1', 'q', 'failed');
    const discard = vi.spyOn(w.stack.userActions, 'discardMedia').mockResolvedValue({ kind: 'discarded', inspectionId: 'q' });
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: 'Discard photo' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard this photo?');
    expect(discard).not.toHaveBeenCalled();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Discard photo' }));
    await waitFor(() => expect(discard).toHaveBeenCalledExactlyOnceWith('m1', { confirmed: true }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  const MEDIA_RESULTS: [string, DiscardMediaOutcome, string][] = [
    ['locked', { kind: 'locked' }, 'The app is locked. Verify online first.'],
    ['not_found', { kind: 'not_found' }, 'This photo is already gone.'],
    ['purging', { kind: 'refused', reason: 'purging' }, 'This inspection is being removed from the device.'],
    ['no_account', { kind: 'refused', reason: 'no_account' }, 'Sign in again to continue.'],
    ['not_removable', { kind: 'refused', reason: 'not_removable' }, 'This photo cannot be discarded from here.'],
    ['file_remove_failed', { kind: 'failed', code: 'file_remove_failed' }, 'The photo file could not be removed. Try again.'],
    ['storage_failed', { kind: 'failed', code: 'storage_failed' }, 'Could not discard the photo. Try again.'],
  ];
  it.each(MEDIA_RESULTS)('discard result %s has a fixed message', async (_name, outcome, text) => {
    await seedPkg(w.db, { id: 'q', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    await seedMedia(w.db, 'm1', 'q', 'failed');
    vi.spyOn(w.stack.userActions, 'discardMedia').mockResolvedValue(outcome);
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: 'Discard photo' }));
    await userEvent.setup().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(text);
  });
});

describe('Queued changes to review (writes that name no inspection)', () => {
  const PAYLOAD = '{"client":"Pat Example","phone":"555-0100"}';

  beforeEach(async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'u1', seq: 1, inspectionId: null, state: 'failed', error: 'rejected', payload: PAYLOAD });
  });

  it('lists them with what they are and explains why they matter', async () => {
    renderList(w.stack);
    const area = await repair();
    expect(within(area).getByText('These queued changes are not linked to an inspection. Until they are removed, the app cannot check for removed inspections.')).toBeInTheDocument();
    expect(within(area).getByText('Inspection edit')).toBeInTheDocument();
  });

  it('counts the changes of another account without listing them', async () => {
    await seedQueued(w.db, { key: 'u2', seq: 2, inspectionId: null, owner: BOB });
    renderList(w.stack);
    expect(within(await repair()).getByText('1 queued change belongs to another account on this device. That account has to sign in to deal with it.')).toBeInTheDocument();
  });

  it('discarding asks first, then shows a copy of the change data, once', async () => {
    const discard = vi.spyOn(w.stack.userActions, 'discardOutboxRow');
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard this queued change?');
    expect(discard).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    expect(discard).toHaveBeenCalledExactlyOnceWith('u1', { confirmed: true });
    expect(within(copy).getByRole('textbox', { name: 'Change data' })).toHaveValue(PAYLOAD);
    expect((await w.db.query('SELECT 1 FROM outbox WHERE idempotency_key = ?', ['u1'])).length).toBe(0);
  });

  it('Copy uses the clipboard when there is one, and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    renderList(w.stack);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    await user.click(within(copy).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
    expect(await within(copy).findByText('Copied.')).toBeInTheDocument();
  });

  it('a clipboard that refuses gives a fixed hint, and the text stays selectable', async () => {
    renderList(w.stack);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    await user.click(within(copy).getByRole('button', { name: 'Copy' }));
    expect(await within(copy).findByText('Could not copy. Select the text and copy it by hand.')).toBeInTheDocument();
    expect(within(copy).getByRole('textbox', { name: 'Change data' })).toHaveValue(PAYLOAD);
  });

  it('with no clipboard there is no Copy button, only the text', async () => {
    renderList(w.stack);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    expect(within(copy).queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('Done removes the text from the screen, and the payload never reaches the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    const copy = await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    await user.click(within(copy).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Removed. Copy of the change data' })).toBeNull();
    expect(document.body.textContent).not.toContain('Pat Example');
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('Pat Example');
  });

  const RESULTS: [string, DiscardOutboxOutcome, string][] = [
    ['locked', { kind: 'locked' }, 'The app is locked. Verify online first.'],
    ['not_found', { kind: 'not_found' }, 'This change is already gone.'],
    ['not_unattributable', { kind: 'refused', reason: 'not_unattributable' }, 'This change is linked to an inspection, so it cannot be discarded from here.'],
    ['foreign', { kind: 'refused', reason: 'foreign' }, 'This change belongs to another account on this device.'],
    ['no_account', { kind: 'refused', reason: 'no_account' }, 'Sign in again to continue.'],
  ];
  it.each(RESULTS)('discard result %s has a fixed message and shows no copy', async (_name, outcome, text) => {
    vi.spyOn(w.stack.userActions, 'discardOutboxRow').mockResolvedValue(outcome);
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('region', { name: 'Removed. Copy of the change data' })).toBeNull();
  });

  it('two confirm taps in one frame discard once', async () => {
    const spy = vi.spyOn(w.stack.userActions, 'discardOutboxRow');
    renderList(w.stack as OfflineStack);
    const user = userEvent.setup();
    await user.click(within(await repair()).getByRole('button', { name: /^Discard/ }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard change' });
    confirm.click();
    confirm.click();
    await screen.findByRole('region', { name: 'Removed. Copy of the change data' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
