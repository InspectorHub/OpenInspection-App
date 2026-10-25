// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import type { RemoveOutcome } from '../offline/user-actions';
import { renderList } from './test-support/worklist-render';
import { at, BOB, createListWorld, seedCached, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const attention = () => screen.findByRole('region', { name: 'Needs attention' });
const orphans = () => screen.findByRole('region', { name: 'Orphan photos on this device' });
const DISCARD_AND_REMOVE = 'Discard and remove this inspection from this device';

describe('stuck photos are scoped to the signed-in account', () => {
  it("another account's stuck photo and a photo with no package never appear under Needs attention", async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedPkg(w.db, { id: 'bobs', scheduledAt: at(0), owner: BOB });
    await seedMedia(w.db, 'mine', 'a', 'failed');
    await seedMedia(w.db, 'theirs', 'bobs', 'failed');
    await seedMedia(w.db, 'ghostly', 'ghost0000', 'failed');
    renderList(w.stack);
    const area = await attention();
    // Positive control: the one photo that is this account's is listed, with its Retry.
    expect(within(area).getAllByRole('button', { name: /^Retry/ })).toHaveLength(1);
    expect(within(area).getAllByText('Photo')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('ghost0000');
    expect(document.body.textContent).not.toContain('Inspection bobs');
    expect(screen.getAllByRole('button', { name: /^Retry/ })).toHaveLength(1);
  });

  it('with only foreign and orphan photos there is no Needs attention list at all', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedPkg(w.db, { id: 'bobs', owner: BOB });
    await seedMedia(w.db, 'theirs', 'bobs', 'failed');
    await seedMedia(w.db, 'ghostly', 'ghost0000', 'failed');
    renderList(w.stack);
    await screen.findByTestId('row-a');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });

  it("retrying goes to the uploader for this account's photo only", async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedPkg(w.db, { id: 'bobs', owner: BOB });
    await seedMedia(w.db, 'mine', 'a', 'failed');
    await seedMedia(w.db, 'theirs', 'bobs', 'failed');
    const retry = vi.spyOn(w.stack.uploader, 'retry').mockResolvedValue(true);
    renderList(w.stack);
    await userEvent.setup().click(within(await attention()).getByRole('button', { name: /^Retry/ }));
    expect(retry).toHaveBeenCalledExactlyOnceWith('mine');
  });
});

describe('orphan photos on this device', () => {
  beforeEach(async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedMedia(w.db, 'ghostly', 'ghost0000', 'failed');
  });

  it('are listed apart, with a Discard and no Retry', async () => {
    renderList(w.stack);
    const area = await orphans();
    expect(within(area).getByRole('button', { name: 'Discard orphan photo' })).toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(area).not.toHaveTextContent('ghost0000');
  });

  it('are discarded after a confirmation that names the consequence, through the confirmed user action', async () => {
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await orphans()).getByRole('button', { name: 'Discard orphan photo' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard this photo?');
    expect(dialog).toHaveAccessibleDescription(/belongs to no inspection on this device\. The file will be permanently removed from this device\. This cannot be undone\./);
    expect((await w.db.query('SELECT 1 FROM media WHERE pending_id = ?', ['ghostly'])).length).toBe(1);
    await user.click(within(dialog).getByRole('button', { name: 'Discard photo' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((await w.db.query('SELECT 1 FROM media WHERE pending_id = ?', ['ghostly'])).length).toBe(0);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Orphan photos on this device' })).toBeNull());
  });

  it('Cancel keeps the photo', async () => {
    const discard = vi.spyOn(w.stack.userActions, 'discardMedia');
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await orphans()).getByRole('button', { name: 'Discard orphan photo' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(discard).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Orphan photos on this device' })).toBeInTheDocument();
  });

  it('a refusal shows a fixed message and keeps the dialog', async () => {
    vi.spyOn(w.stack.userActions, 'discardMedia').mockResolvedValue({ kind: 'locked' });
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await orphans()).getByRole('button', { name: 'Discard orphan photo' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('The app is locked. Verify online first.');
  });

  it("another account's photos are only counted", async () => {
    await seedPkg(w.db, { id: 'bobs', owner: BOB });
    await seedMedia(w.db, 'theirs', 'bobs', 'failed');
    renderList(w.stack);
    const area = await orphans();
    expect(within(area).getByText('1 photo or clip belongs to another account on this device. That account has to sign in to deal with it.')).toBeInTheDocument();
    expect(within(area).getAllByRole('button', { name: /Discard/ })).toHaveLength(1);
  });
});

describe('the discard dialog says what is lost', () => {
  async function open(op: string, address: string | null = '12 Elm Street'): Promise<HTMLElement> {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    if (address !== null) await seedCached(w.db, 'a', address);
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'rejected', op });
    renderList(w.stack);
    await userEvent.setup().click(within(await attention()).getByRole('button', { name: /^Discard/ }));
    return screen.findByRole('alertdialog');
  }

  it('an edit: the kind of change, the inspection, and what will not be sent', async () => {
    const dialog = await open('inspection.update');
    expect(dialog).toHaveAccessibleDescription(/Inspection edit for 12 Elm Street\. These edits to the inspection details will not be sent\. The queued change will be permanently removed \(7 bytes\)\. This cannot be undone\./);
  });

  it('a completion', async () => {
    const dialog = await open('inspection.complete');
    expect(dialog).toHaveAccessibleDescription(/Mark complete for 12 Elm Street\. Marking the inspection complete will not be sent\./);
  });

  it('a kind this version does not know gets the general line, never the raw operation name', async () => {
    const dialog = await open('something.else');
    expect(dialog).toHaveAccessibleDescription(/Queued change for 12 Elm Street\. This queued change will not be sent\./);
    expect(dialog).not.toHaveTextContent('something.else');
  });

  it('an inspection without a cached address is named by its short id', async () => {
    const dialog = await open('inspection.update', null);
    expect(dialog).toHaveAccessibleDescription(/Inspection edit for Inspection a\. These edits/);
  });
});

describe('a failed create has one exit that leaves nothing behind', () => {
  async function seedFailedCreate(): Promise<void> {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedCached(w.db, 'mine00001', '9 Oak Road');
    await seedQueued(w.db, { key: 'c1', seq: 1, inspectionId: 'mine00001', state: 'failed', error: 'rejected', op: 'inspection.create' });
    await seedQueued(w.db, { key: 'u1', seq: 2, inspectionId: 'mine00001', op: 'inspection.update' });
    await seedMedia(w.db, 'p1', 'mine00001', 'pending');
    await seedPkg(w.db, { id: 'other0001', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'u2', seq: 3, inspectionId: 'other0001' });
    await seedMedia(w.db, 'p2', 'other0001', 'pending');
  }

  it('offers Retry and the one combined action, and no plain Discard', async () => {
    await seedFailedCreate();
    renderList(w.stack);
    const area = await attention();
    expect(within(area).getByRole('button', { name: /^Retry New inspection/ })).toBeInTheDocument();
    expect(within(area).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) })).toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: /^Discard New inspection/ })).toBeNull();
  });

  it('the dialog says it was never sent and everything for it goes, with the current counts, and sends nothing until confirmed', async () => {
    await seedFailedCreate();
    const discard = vi.spyOn(w.stack.replayer, 'discard');
    renderList(w.stack);
    await userEvent.setup().click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription('This inspection was never sent to the server. Everything on this device for it, including photos and edits, will be permanently removed. This cannot be undone.');
    await within(dialog).findByText('Queued changes: 2');
    expect(within(dialog).getByText('Photos and clips waiting to upload: 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Created on this device and never sent: Yes')).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();
  });

  it('confirming discards the create and removes the inspection with all of its data, and no other inspection changes', async () => {
    await seedFailedCreate();
    const discard = vi.spyOn(w.stack.replayer, 'discard');
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 2');
    await user.click(within(dialog).getByRole('button', { name: DISCARD_AND_REMOVE }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(discard).toHaveBeenCalledExactlyOnceWith('c1', { confirmed: true });
    expect(await screen.findByText('Removed from this device.')).toBeInTheDocument();
    expect(await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['mine00001'])).toHaveLength(0);
    expect(await w.db.query('SELECT 1 FROM outbox WHERE inspection_id = ?', ['mine00001'])).toHaveLength(0);
    expect(await w.db.query('SELECT 1 FROM media WHERE inspection_id = ?', ['mine00001'])).toHaveLength(0);
    expect(await w.db.query('SELECT 1 FROM resource_cache WHERE package_id = ?', ['mine00001'])).toHaveLength(0);
    expect(await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['other0001'])).toHaveLength(1);
    expect(await w.db.query('SELECT 1 FROM outbox WHERE inspection_id = ?', ['other0001'])).toHaveLength(1);
    expect(await w.db.query('SELECT 1 FROM media WHERE inspection_id = ?', ['other0001'])).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId('row-mine00001')).toBeNull());
  });

  it('a discard that reports nothing found is fine when the create is already gone: the removal goes on', async () => {
    await seedFailedCreate();
    vi.spyOn(w.stack.replayer, 'discard').mockImplementation(async (key) => {
      await w.db.run('DELETE FROM outbox WHERE idempotency_key = ?', [key]);
      return false;
    });
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 2');
    await user.click(within(dialog).getByRole('button', { name: DISCARD_AND_REMOVE }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['mine00001'])).toHaveLength(0);
  });

  it('a discard that reports nothing found while the create is still queued stops with a fixed line and removes nothing', async () => {
    await seedFailedCreate();
    vi.spyOn(w.stack.replayer, 'discard').mockResolvedValue(false);
    const remove = vi.spyOn(w.stack.userActions, 'removeFromDevice');
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 2');
    await user.click(within(dialog).getByRole('button', { name: DISCARD_AND_REMOVE }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not discard this change. It may already be gone.');
    expect(remove).not.toHaveBeenCalled();
    expect(await w.db.query('SELECT 1 FROM work_package WHERE inspection_id = ?', ['mine00001'])).toHaveLength(1);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
  });

  it('two taps in one frame discard once', async () => {
    await seedFailedCreate();
    const discard = vi.spyOn(w.stack.replayer, 'discard');
    renderList(w.stack);
    await userEvent.setup().click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 2');
    const confirm = within(dialog).getByRole('button', { name: DISCARD_AND_REMOVE });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('when the removal fails after the create was discarded, the dialog stays with a fixed line and fresh counts, and the row can be removed later', async () => {
    await seedFailedCreate();
    const busy: RemoveOutcome = { kind: 'busy' };
    const stack: OfflineStack = { ...w.stack, userActions: { ...w.stack.userActions, removeFromDevice: vi.fn(() => Promise.resolve(busy)) } };
    renderList(stack);
    const user = userEvent.setup();
    await user.click(within(await attention()).getByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText('Queued changes: 2');
    await user.click(within(dialog).getByRole('button', { name: DISCARD_AND_REMOVE }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Another sync step is running. Try again in a moment.');
    await within(dialog).findByText('Queued changes: 1');
    expect(await w.db.query('SELECT 1 FROM outbox WHERE idempotency_key = ?', ['c1'])).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // Nothing queued makes it any more: the row itself now offers the removal.
    const row = await screen.findByTestId('row-mine00001');
    expect(within(row).getByRole('button', { name: 'Remove from this device' })).toBeInTheDocument();
    expect(within(row).getByText('Created on this device, not yet sent')).toBeInTheDocument();
  });

  it('a create whose inspection is not on the list gets the plain discard, with its own consequence line', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'c1', seq: 1, inspectionId: 'lost00001', state: 'failed', error: 'rejected', op: 'inspection.create' });
    renderList(w.stack);
    const user = userEvent.setup();
    const area = await attention();
    expect(within(area).queryByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) })).toBeNull();
    await user.click(within(area).getByRole('button', { name: /^Discard New inspection/ }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleDescription(/New inspection for Inspection lost0000\. This new inspection will not be sent to the server\./);
  });

  it('an update on a package that was never sent still gets the plain discard (only the create has the combined action)', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedQueued(w.db, { key: 'u1', seq: 1, inspectionId: 'mine00001', state: 'failed', error: 'rejected', op: 'inspection.update' });
    await seedQueued(w.db, { key: 'c1', seq: 2, inspectionId: 'mine00001', op: 'inspection.create' });
    renderList(w.stack);
    const area = await attention();
    expect(within(area).getByRole('button', { name: /^Discard Inspection edit/ })).toBeInTheDocument();
    expect(within(area).queryByRole('button', { name: new RegExp(`^${DISCARD_AND_REMOVE}`) })).toBeNull();
  });
});

describe('a package that was never sent can always be removed from its row', () => {
  it('shows the removal on the row once no create is queued, and the dialog explains it was never sent', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    renderList(w.stack);
    const row = await screen.findByTestId('row-mine00001');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Remove from this device' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(/This inspection was never sent to the server\./);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Remove from this device' }));
    await waitFor(() => expect(screen.queryByTestId('row-mine00001')).toBeNull());
  });

  it('no removal is offered while its create is still queued', async () => {
    await seedPkg(w.db, { id: 'mine00001', scheduledAt: at(0), confirmed: 0 });
    await seedQueued(w.db, { key: 'c1', seq: 1, inspectionId: 'mine00001', op: 'inspection.create' });
    renderList(w.stack);
    const row = await screen.findByTestId('row-mine00001');
    expect(within(row).queryByRole('button', { name: /Remove from this device/ })).toBeNull();
  });
});
