// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData } from '../app/test-support/world';
import { refreshTokenKey } from '../auth/server-config';
import { setHapticsPort } from '../platform/haptics';
import { backRegistry, createBackRegistry, pressBack } from './back-button';
import { compat, open } from './test-support/settings-world';

afterEach(() => {
  cleanup();
  setHapticsPort(null);
});

const exitSpy = (): (() => void) => vi.fn();

describe('Settings: export', () => {
  it('hands the export to the caller and changes nothing', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { onExport } = await open(world);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export unsent data' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(await rowCounts(world.db)).toEqual(before);
  });
});

describe('Settings: clear local data', () => {
  async function ask(world: Awaited<ReturnType<typeof createSignedInWorld>>) {
    const view = await open(world);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).queryByText(/Counting/)).toBeNull());
    return { ...view, user, dialog };
  }

  it('with nothing unsent: one confirmation, and it says that everything was uploaded', async () => {
    const world = await createSignedInWorld();
    const { dialog, user, onCleared } = await ask(world);
    expect(dialog).toHaveTextContent('Everything on this device has been uploaded.');
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeUndefined();
  });

  it('with unsent data: the first dialog shows the counts and cannot clear; only the second, deliberate step does', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.db.run('UPDATE work_package SET server_confirmed = 0');
    await world.files.write('/p', new Uint8Array([1]));
    const before = await rowCounts(world.db);
    const { dialog, user, onCleared } = await ask(world);
    expect(within(dialog).getByTestId('at-risk')).toHaveTextContent('2 photos, clips and changes not uploaded');
    expect(within(dialog).getByTestId('at-risk')).toHaveTextContent('1 inspection created on this device and not yet on the server');
    // The seeded document has no proof from the server that it holds the edits.
    expect(within(dialog).getByTestId('at-risk')).toHaveTextContent('1 inspection with edits not yet on the server');
    expect(within(dialog).queryByRole('button', { name: 'Clear local data' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);

    const second = await screen.findByRole('alertdialog');
    expect(second).toHaveAccessibleName('Delete 4 items that are not uploaded?');
    expect(within(second).getByRole('button', { name: 'Keep my data' })).toHaveFocus();
    expect(await rowCounts(world.db)).toEqual(before);

    await user.click(within(second).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    const after = await rowCounts(world.db);
    expect(after.media).toBe(0);
    expect(after.outbox).toBe(0);
  });

  it('keeping the data at the second step removes nothing, and the dialog goes away', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { dialog, user, onCleared } = await ask(world);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep my data' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
    expect(screen.getByRole('button', { name: 'Clear local data' })).toHaveFocus();
  });

  it('Cancel on the first dialog removes nothing', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { dialog, user } = await ask(world);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('when what is unsent cannot be counted, it is treated as unsent: the second step is still required', async () => {
    const world = await createSignedInWorld();
    const failing = { ...world.db, query: () => Promise.reject(new Error('busy')) };
    const view = await open(world, { services: { ...world.services, db: failing } as never });
    void view;
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(dialog).toHaveTextContent('could not count');
    expect(within(dialog).queryByRole('button', { name: 'Clear local data' })).toBeNull();
  });

  it('the destructive confirmation vibrates and a cancel does not', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    const { dialog, user, onCleared } = await ask(world);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(notify).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const again = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(again).getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(within(again).getByRole('button', { name: 'Continue' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('warning'));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    // One vibration for the whole flow: the warning on the confirmation, no second one when it finishes.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a file that cannot be removed is reported and onCleared waits for the person to close that message', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    world.files.failRemoveFor('/p');
    const { dialog, user, onCleared } = await ask(world);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete everything' }));
    const result = await screen.findByRole('dialog', { name: 'Local data cleared' });
    expect(result).toHaveTextContent('1 photo file could not be removed');
    expect(onCleared).not.toHaveBeenCalled();
    await user.click(within(result).getByRole('button', { name: 'Close' }));
    expect(onCleared).toHaveBeenCalledTimes(1);
  });
});

describe('Settings: sign out', () => {
  it('asks first, signs out only this server, keeps every row and vibrates once on success', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { onSignedOut } = await open(world);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('success');
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeUndefined();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('cancelling does not sign out and does not vibrate', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const world = await createSignedInWorld();
    const { onSignedOut } = await open(world);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeTruthy();
  });
});

describe('Settings: the version policy never closes the ways out', () => {
  async function everythingStillWorks(world: Awaited<ReturnType<typeof createSignedInWorld>>) {
    const { onExport, onSignedOut } = await open(world);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Export unsent data' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear local data' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Export unsent data' }));
    expect(onExport).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  }

  it('upgrade required', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.noteUpgrade(world.server.origin, 'required');
    await everythingStillWorks(world);
  });

  it('server too old', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true, serverContractVersion: 0 }));
    await everythingStillWorks(world);
  });
});

describe('Settings: going back', () => {
  it('the Back button and the system back key both return to the list; the back key does not leave the app', async () => {
    const world = await createSignedInWorld();
    const { onBack } = await open(world);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to work list' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    const exit = exitSpy();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it('with a dialog open the back key closes the dialog first, and Settings stays', async () => {
    const world = await createSignedInWorld();
    const { onBack } = await open(world);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('alertdialog');
    const exit = exitSpy();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('leaves no registration behind once Settings is closed', async () => {
    const world = await createSignedInWorld();
    const before = backRegistry.size();
    await open(world);
    expect(backRegistry.size()).toBe(before + 1);
    cleanup();
    expect(backRegistry.size()).toBe(before);
    const exit = exitSpy();
    pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
