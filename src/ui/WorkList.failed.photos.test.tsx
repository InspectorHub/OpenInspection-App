// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedMedia, seedPkg, type ListWorld } from './test-support/worklist-world';
import { DISCARD_DEFECT_PHOTO_DESCRIPTION } from './worklist/copy';

let w: ListWorld;

const DEFECT = { meta: JSON.stringify({ targetType: 'defect', findingKey: '_default:s1:i1', itemId: 'i1', customId: 'd1', defectKind: 'custom' }) };
const ITEM = { meta: JSON.stringify({ targetType: 'item', findingKey: '_default:s1:i1', itemId: 'i1' }) };

beforeEach(async () => {
  w = await createListWorld();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const panel = () => screen.findByRole('region', { name: 'Needs attention' });
const mediaIds = async (): Promise<string[]> => (await w.db.query<{ pending_id: string }>('SELECT pending_id FROM media ORDER BY pending_id')).map((r) => r.pending_id);

describe('Needs attention lists only photos that stopped for good', () => {
  it('a photo that failed but is still being retried is not listed; control: one at the attempt limit is', async () => {
    await seedMedia(w.db, 'transient', 'a', 'failed', { attempts: 4, ...ITEM });
    renderList(w.stack);
    await screen.findByTestId('row-a');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    cleanup();
    await seedMedia(w.db, 'refused', 'a', 'failed', { attempts: MAX_UPLOAD_ATTEMPTS, ...ITEM });
    renderList(w.stack);
    expect(within(await panel()).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('Needs attention: the words tell the kinds apart and never promise an automatic upload', () => {
  it('an item photo points to the editor; a defect photo says it stays until retried or discarded', async () => {
    await seedMedia(w.db, 'item', 'a', 'failed', ITEM);
    await seedMedia(w.db, 'defect', 'a', 'failed', DEFECT);
    renderList(w.stack);
    const lines = within(await panel()).getAllByRole('listitem').map((li) => li.textContent ?? '');
    const item = lines.find((l) => l.includes('remove it from the inspection in the editor'));
    const defect = lines.find((l) => l.includes('defect photo'));
    expect(item).toBeDefined();
    expect(defect).toBeDefined();
    expect(item).not.toBe(defect);
    for (const line of [item ?? '', defect ?? '']) {
      expect(line).toContain('will not upload by itself');
      expect(line).not.toMatch(/automatically|will be uploaded|will retry|try again later/i);
    }
  });
});

describe('Needs attention: discarding a defect photo that stopped for good', () => {
  it('is offered for a defect photo and not for an item photo of the same healthy inspection', async () => {
    await seedMedia(w.db, 'item', 'a', 'failed', ITEM);
    renderList(w.stack);
    expect(within(await panel()).getByRole('button', { name: /^Retry photo, / })).toBeInTheDocument();
    expect(within(await panel()).queryByRole('button', { name: /^Discard/ })).toBeNull();
    cleanup();
    await seedMedia(w.db, 'defect', 'a', 'failed', DEFECT);
    renderList(w.stack);
    expect(await within(await panel()).findAllByRole('button', { name: /^Discard photo, / })).toHaveLength(1);
  });

  it('asks first in a custom dialog that says what is lost, and removes nothing until it is confirmed; Cancel keeps it', async () => {
    await seedMedia(w.db, 'defect', 'a', 'failed', DEFECT);
    await w.world.files.write('media/defect.jpg', new Uint8Array([1]));
    const confirm = vi.spyOn(window, 'confirm');
    const discard = vi.spyOn(w.stack.userActions, 'discardMedia');
    renderList(w.stack);
    const user = userEvent.setup();
    await user.click(within(await panel()).getByRole('button', { name: /^Discard photo, / }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Discard this photo?');
    expect(dialog).toHaveAccessibleDescription(DISCARD_DEFECT_PHOTO_DESCRIPTION);
    expect(discard).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
    expect(await mediaIds()).toEqual(['defect']);
    await user.click(within(await panel()).getByRole('button', { name: /^Discard photo, / }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' }));
    await waitFor(() => expect(discard).toHaveBeenCalledExactlyOnceWith('defect', { confirmed: true }));
    await waitFor(async () => expect(await mediaIds()).toEqual([]));
    expect(w.world.files.paths()).not.toContain('media/defect.jpg');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a double tap on the confirm button discards once', async () => {
    await seedMedia(w.db, 'defect', 'a', 'failed', DEFECT);
    const discard = vi.spyOn(w.stack.userActions, 'discardMedia');
    renderList(w.stack);
    await userEvent.setup().click(within(await panel()).getByRole('button', { name: /^Discard photo, / }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard photo' });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(discard).toHaveBeenCalled());
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
