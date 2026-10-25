// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileGate } from '../export/reconcile-gate';
import { createExportWorld, seedInspection, sharedPackage, snapshotTables, type ExportWorld } from '../export/test-support/world';
import { ExportFlow, type ExportFlowProps } from './ExportFlow';

afterEach(cleanup);

const RESPONSIBILITY = (who: string): string => `This file contains customers' personal information and is not encrypted. ${who} is responsible for storing and deleting the file.`;
const UNCONFIRMED = 'We could not confirm these inspections still exist, so the receiving office may refuse some of them.';
const QUARANTINE_LABEL = 'Include inspections that were removed from my list (quarantined)';

async function threeWithOneQuarantined(world: ExportWorld): Promise<void> {
  for (const id of ['insp-a', 'insp-b', 'insp-c']) await seedInspection(world, id, { quarantined: id === 'insp-b', writes: ['update'], photos: [{ pendingId: `photo-${id}` }] });
}

function view(world: ExportWorld, props: Partial<ExportFlowProps> = {}) {
  const onClose = vi.fn();
  render(<ExportFlow services={{ db: world.db, files: world.files, clock: world.clock }} sharer={world.sharer} reconcile={() => Promise.resolve(true)} onClose={onClose} {...props} />);
  return { onClose };
}

async function ready(): Promise<HTMLElement> {
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Export' })).toBeEnabled());
  return dialog;
}

describe('the question before an export', () => {
  it('states that the file is unencrypted and who keeps it, with the company name when it is known', async () => {
    const world = await createExportWorld({ company: 'Acme Inspections' });
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    expect(within(dialog).getByText(RESPONSIBILITY('Acme Inspections'))).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { description: RESPONSIBILITY('Acme Inspections') })).toBe(dialog);
  });

  it('uses a neutral sentence of the same shape when the company is not stored', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    expect(within(dialog).getByText(RESPONSIBILITY('Your company'))).toBeInTheDocument();
  });

  it('offers the quarantine choice, off by default, as a labelled checkbox with a touch-sized row', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    await ready();
    const box = screen.getByRole('checkbox', { name: QUARANTINE_LABEL });
    expect(box).not.toBeChecked();
    expect(box.closest('label')?.className).toContain('min-h-11');
  });

  it('never uses the browser confirm', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    const confirm = vi.spyOn(window, 'confirm');
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps Export off while the check with the server is running, and says so', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    let answer: (confirmed: boolean) => void = () => undefined;
    const reconcile: ReconcileGate = () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    view(world, { reconcile });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking which inspections are still on your list');
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await act(async () => {
      answer(true);
      await Promise.resolve();
    });
    await ready();
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();
  });

  it('warns before the choice when the list could not be confirmed, and still lets the person export', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world, { reconcile: () => Promise.resolve(false) });
    const dialog = await ready();
    expect(within(dialog).getByText(UNCONFIRMED)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('on the lock screen there is no way to ask, so the same warning shows', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world, { reconcile: undefined });
    const dialog = await ready();
    expect(within(dialog).getByText(UNCONFIRMED)).toBeInTheDocument();
  });

  it('Cancel closes without exporting anything', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    const { onClose } = view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(world.sharer.calls).toEqual([]);
    expect(world.files.writtenBytes()).toBe(0);
  });
});

describe('what is exported follows the choice', () => {
  it('by default the quarantined inspection stays out', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(sharedPackage(world).manifest.inspections.map((row) => row.id).sort()).toEqual(['insp-a', 'insp-c']);
  });

  it('with the box ticked it goes with the rest', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: QUARANTINE_LABEL }));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(sharedPackage(world).manifest.inspections.map((row) => row.id).sort()).toEqual(['insp-a', 'insp-b', 'insp-c']);
  });

  it('the export on one quarantined row has no choice to make and holds that inspection alone', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world, { only: ['insp-b'] });
    await ready();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(sharedPackage(world).manifest.inspections.map((row) => row.id)).toEqual(['insp-b']);
  });

  it('changes nothing in the database', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    const before = await snapshotTables(world.db);
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(await snapshotTables(world.db)).toEqual(before);
  });
});

describe('pressing Export twice in one frame', () => {
  it('starts one export and opens one share sheet', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    const button = within(dialog).getByRole('button', { name: 'Export' });
    act(() => {
      button.click();
      button.click();
    });
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(world.sharer.calls).toHaveLength(1);
  });

  it('shows a progress line while it builds, and the buttons are off', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inSheet = new Promise<void>((resolve) => {
      entered = resolve;
    });
    world.sharer.during = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    view(world);
    const dialog = await ready();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Export' }));
    await inSheet;
    expect(within(dialog).getByRole('status')).toHaveTextContent('Preparing the export');
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'Export finished' });
  });
});

describe('what the person is told afterwards', () => {
  it('a shared export says what it held and that the file is gone, and Close leaves', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    const { onClose } = view(world);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(/2 inspections, 2 photos, 2 changes waiting to upload/)).toBeInTheDocument();
    expect(within(result).getByText(/temporary file was deleted/)).toBeInTheDocument();
    expect(within(result).queryByText(UNCONFIRMED)).toBeNull();
    expect(within(result).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.click(within(result).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('repeats the warning in the result when the list was not confirmed', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world, { reconcile: () => Promise.resolve(false) });
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(UNCONFIRMED)).toBeInTheDocument();
  });

  it('a cancelled share says so, and that the file was deleted', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    world.sharer.mode = 'cancel';
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByRole('heading', { name: 'Export cancelled' })).toBeInTheDocument();
    expect(within(result).getByText(/export file was deleted/)).toBeInTheDocument();
    expect(world.files.cacheNames()).toEqual([]);
  });

  it('a failed share keeps the question open with a fixed sentence, and the person can try again', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    world.sharer.mode = 'error';
    view(world);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The share sheet could not be opened. Nothing on this device was changed. Try again.');
    expect(alert.textContent).not.toMatch(/Activity not found/);
    expect(world.files.cacheNames()).toEqual([]);
    world.sharer.mode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
  });

  it('says what the package could not carry', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { photos: [{ pendingId: 'p1' }, { pendingId: 'clip', kind: 'video' }, { pendingId: 'gone' }] });
    world.files.failReadFor('media/gone.jpg');
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(/1 photo could not be read and was left out/)).toBeInTheDocument();
    expect(within(result).getByText(/Recorded video clips cannot be exported/)).toBeInTheDocument();
  });

  it('tells the person when there is nothing on the device to export', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-b', { quarantined: true, writes: ['update'] });
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByRole('heading', { name: 'Nothing to export' })).toBeInTheDocument();
    expect(world.sharer.calls).toEqual([]);
  });

  it('reports a file that could not be deleted', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    world.files.failRemoveCache();
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(/could not be deleted/)).toBeInTheDocument();
  });
});
