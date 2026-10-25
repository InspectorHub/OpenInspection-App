// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExportWorld, createManualTimers, seedInspection, sharedPackage } from '../export/test-support/world';
import { ExportFlow } from './ExportFlow';
import { QUARANTINE_LABEL, ready, threeWithOneQuarantined, view } from './test-support/export-view';

afterEach(cleanup);

describe('the question shows what will happen', () => {
  it('counts what will be exported and what is left out, and offers the choice only when something was removed', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    expect(within(dialog).getByText('2 inspections will be exported. 1 removed one is left out.')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: QUARANTINE_LABEL })).toBeInTheDocument();
  });

  it('control: with nothing removed there is no choice to make', async () => {
    const world = await createExportWorld();
    for (const id of ['insp-a', 'insp-b', 'insp-c']) await seedInspection(world, id, { writes: ['update'] });
    view(world);
    const dialog = await ready();
    expect(within(dialog).getByText('3 inspections will be exported.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('says in the question and in the result that inspections without a report id may be refused, and that they are still included', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['update'] });
    await seedInspection(world, 'insp-b', { writes: ['update'], reportId: 'report-b' });
    view(world);
    const dialog = await ready();
    const sentence = '1 inspection may be refused by the receiving office because this server did not provide its report id. It is still included.';
    expect(within(dialog).getByText(sentence)).toBeInTheDocument();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(sentence)).toBeInTheDocument();
    expect(sharedPackage(world).manifest.inspections).toHaveLength(2);
  });

  it('control: when every report id is known the sentence is not there', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['update'], reportId: 'report-a' });
    view(world);
    await ready();
    expect(screen.queryByText(/may be refused by the receiving office/)).toBeNull();
  });

  it('a check that fails leaves Export possible, says so in a fixed sentence, and can be tried again', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { writes: ['update'], reportId: 'report-a' });
    const real = world.db.transaction.bind(world.db);
    let failures = 1;
    vi.spyOn(world.db, 'transaction').mockImplementation(((fn: Parameters<typeof real>[0]) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('disk says: secret detail'));
      }
      return real(fn);
    }) as typeof real);
    view(world);
    const dialog = await ready();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The app could not check what this device holds. You can still export, or try the check again.');
    expect(dialog.textContent).not.toMatch(/secret detail/);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
    expect(within(dialog).getByText('1 inspection will be exported.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('two clicks in one frame start one export and never flash "An export is already running."', async () => {
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
    const button = within(dialog).getByRole('button', { name: 'Export' });
    act(() => {
      button.click();
      button.click();
    });
    await inSheet;
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('An export is already running.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(world.sharer.calls).toHaveLength(1);
  });

  it('turns the quarantine choice off while the export builds', async () => {
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
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await inSheet;
    expect(screen.getByRole('checkbox', { name: QUARANTINE_LABEL })).toBeDisabled();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'Export finished' });
  });
});

describe('what the result says about what stayed behind', () => {
  it('lists refused changes, refused creations and what the server already held', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-a', { edits: 1, writes: ['update', 'complete'] });
    await world.db.run("UPDATE outbox SET state = 'failed' WHERE op = 'inspection.complete'");
    await seedInspection(world, 'insp-new', { confirmed: false, edits: 1, writes: ['create'], writeState: 'failed' });
    await seedInspection(world, 'insp-held', { edits: 2, server: 'all' });
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText('1 change the server refused stay on this device.')).toBeInTheDocument();
    expect(within(result).getByText('1 inspection could not be exported because their creation was refused; they stay on this device.')).toBeInTheDocument();
    expect(within(result).getByText('1 inspection was already fully on the server and was left out.')).toBeInTheDocument();
    expect(sharedPackage(world).manifest.inspections.map((row) => row.id)).toEqual(['insp-a']);
  });
});

describe('on Android the result promises ten minutes', () => {
  it.each(['ok', 'cancel'] as const)('for a share that answered %s', async (mode) => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    world.sharer.mode = mode;
    const timers = createManualTimers();
    render(<ExportFlow services={{ db: world.db, files: world.files, clock: world.clock, platform: 'android' }} sharer={world.sharer} timers={timers} reconcile={() => Promise.resolve(true)} onClose={vi.fn()} />);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const result = await screen.findByRole('dialog');
    expect(within(result).getByText(/The temporary file will be deleted within 10 minutes\./)).toBeInTheDocument();
    expect(within(result).queryByText(/was deleted/)).toBeNull();
    expect(world.files.cacheNames()).toHaveLength(1);
    expect(timers.pending()).toEqual([600_000]);
  });
});
