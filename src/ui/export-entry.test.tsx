// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { OfflineStack } from '../app/offline-stack';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld, restartOffline, rowCounts } from '../app/test-support/world';
import { DAY_MS } from '../offline/lock';
import { fakeScheduler } from '../offline/test-support/fakes';
import { reconcileOutcome, renderList } from './test-support/worklist-render';
import { at, createListWorld, seedPkg } from './test-support/worklist-world';
import { seedExportableForSignedIn } from './test-support/export-view';
import { SignedIn } from './SignedIn';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };
const EXPORT_BUTTON = { name: 'Export unsent data' } as const;

describe('the export entry in the work list', () => {
  it('the header offers it when the host supplies the action, and calls it', async () => {
    const list = await createListWorld();
    await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
    const onExportAll = vi.fn();
    renderList(list.stack, { onExportAll });
    await screen.findByTestId('row-a');
    await userEvent.setup().click(screen.getByRole('button', EXPORT_BUTTON));
    expect(onExportAll).toHaveBeenCalledTimes(1);
  });

  it('control: the header shows no export without the action', async () => {
    const list = await createListWorld();
    await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
    renderList(list.stack);
    await screen.findByTestId('row-a');
    expect(screen.queryByRole('button', EXPORT_BUTTON)).toBeNull();
  });
});

describe('the export entry in the signed-in screen', () => {
  it('opens the question, and asks the reconcile of the live stack once', async () => {
    const world = await createSignedInWorld();
    await seedExportableForSignedIn(world.db);
    const list = await createListWorld();
    const trigger = vi.fn();
    let latest = reconcileOutcome({ status: 'never', at: null });
    const stack: OfflineStack = {
      ...list.stack,
      reconciler: {
        trigger: (reason) => {
          trigger(reason);
          latest = reconcileOutcome({ status: 'done', at: 5 });
        },
        onNeedsReconcile: () => undefined,
        get last() {
          return latest;
        },
        idle: () => Promise.resolve(),
      },
    };
    render(
      <OfflineStackContext.Provider value={stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Work list' });
    await userEvent.setup().click(screen.getByRole('button', EXPORT_BUTTON));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Export' })).toBeEnabled());
    expect(trigger.mock.calls.filter(([reason]) => reason === 'manual')).toHaveLength(1);
    expect(within(dialog).queryByText(/could not confirm/)).toBeNull();
  });

  it('without an offline stack it still offers the export, and the dialog says the list is unconfirmed', async () => {
    const world = await createSignedInWorld();
    await seedExportableForSignedIn(world.db);
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', EXPORT_BUTTON));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/could not confirm these inspections still exist/)).toBeInTheDocument();
  });

  it('still offers it while the server demands an update: editing is off, exporting is not', async () => {
    const world = await createSignedInWorld();
    await seedExportableForSignedIn(world.db);
    world.services.clientState.noteUpgrade(world.server.origin, 'required');
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Update required' })).toBeInTheDocument();
    const button = screen.getByRole('button', EXPORT_BUTTON);
    expect(button).toBeEnabled();
    await userEvent.setup().click(button);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('the export entry on the lock screen', () => {
  it('a locked device can export: the button is there and opens the question; cancelling changes nothing', async () => {
    const world = await createSignedInWorld();
    await seedExportableForSignedIn(world.db);
    world.clock.advance(31 * DAY_MS);
    const before = await rowCounts(world.db);
    const { services } = restartOffline(world);
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', EXPORT_BUTTON));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/is responsible for storing and deleting the file/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/could not confirm these inspections still exist/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await rowCounts(world.db)).toEqual(before);
  });
});
