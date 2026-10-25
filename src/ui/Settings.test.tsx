// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData } from '../app/test-support/world';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { recordVerified } from '../offline/lock-state';
import { readSyncDays } from '../offline/work-package';
import { compat, open, stackWith } from './test-support/settings-world';
import { Settings } from './Settings';
import { LICENSE_URL, SOURCE_URL } from './settings/AboutSection';
import { LINK_FAILED } from './settings/ExternalLink';
import { SAVED_OFFLINE_WORK } from './settings/SyncSection';

afterEach(cleanup);

describe('Settings structure', () => {
  it('has one first-level heading, real second-level headings for every section, and no skipped level', async () => {
    const world = await createSignedInWorld();
    await open(world);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
    const names = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(['Sync', 'This device', 'Your data', 'Account', 'Open source']);
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('moves focus to the title when it opens', async () => {
    const world = await createSignedInWorld();
    await open(world);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('every control is at least 44 px tall (the button base class) and has an accessible name', async () => {
    const world = await createSignedInWorld();
    await open(world);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
      expect(button).toHaveAccessibleName();
    }
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.closest('label')?.className).toContain('min-h-11');
      expect(radio).toHaveAccessibleName();
    }
  });

  it('uses theme tokens only: no literal colour in any class', async () => {
    const world = await createSignedInWorld();
    const view = render(<Settings services={world.services} origin={world.server.origin} stack={null} onBack={vi.fn()} onExport={vi.fn()} onSignedOut={vi.fn()} onCleared={vi.fn()} timers={createManualTimers()} />);
    const classes = [...view.container.querySelectorAll('[class]')].map((el) => el.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/#[0-9a-f]{3,6}\b|\b(?:bg|text|border)-(?:white|black|gray|slate|red|blue|green)\b/i);
  });
});

describe('Sync window', () => {
  it('offers 7, 14 and 30 days, with 14 chosen by default', async () => {
    const world = await createSignedInWorld();
    await open(world);
    expect(screen.getByRole('group', { name: 'Download work scheduled in the next' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: '14 days' })).toBeChecked());
    expect(screen.getByRole('radio', { name: '7 days' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: '30 days' })).not.toBeChecked();
  });

  it('shows the stored choice, and no choice at all for a value the screen does not offer', async () => {
    const world = await createSignedInWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('sync_days', '30')");
    await open(world);
    await waitFor(() => expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked());
    cleanup();
    await world.db.run("UPDATE device_state SET value = '21' WHERE key = 'sync_days'");
    await open(world);
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('choosing 30 saves it where the refresher reads it, and asks for exactly one download', async () => {
    const world = await createSignedInWorld();
    const stack = stackWith();
    await open(world, { stack });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(stack.refresh).toHaveBeenCalledTimes(1));
    expect(stack.refresh).toHaveBeenCalledWith({ reason: 'manual' });
    expect(await readSyncDays(world.db)).toBe(30);
    expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent(/1 inspection/i));
  });

  it('choosing the value already chosen does nothing (control: a different value does)', async () => {
    const world = await createSignedInWorld();
    const stack = stackWith();
    await open(world, { stack });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('radio', { name: '14 days' })).toBeChecked());
    await user.click(screen.getByRole('radio', { name: '14 days' }));
    expect(stack.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(stack.refresh).toHaveBeenCalledTimes(1));
  });

  it('shrinking the window removes nothing from the device', async () => {
    const world = await createSignedInWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('sync_days', '30')");
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const stack = stackWith();
    await open(world, { stack });
    await waitFor(() => expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked());
    await userEvent.setup().click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(stack.refresh).toHaveBeenCalledTimes(1));
    const after = await rowCounts(world.db);
    expect(after).toEqual(before);
    expect(await readSyncDays(world.db)).toBe(7);
  });

  it('without a session stack the choice is saved and the next download uses it; no request is made', async () => {
    const world = await createSignedInWorld();
    const before = world.fetched.length;
    await open(world, { stack: null });
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent(SAVED_OFFLINE_WORK));
    expect(await readSyncDays(world.db)).toBe(7);
    expect(world.fetched.length).toBe(before);
  });

  it('when the server is too old the choice is saved and nothing is requested (control: current server requests)', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true }));
    const stack = stackWith();
    await open(world, { stack });
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent(SAVED_OFFLINE_WORK));
    expect(stack.refresh).not.toHaveBeenCalled();
    expect(await readSyncDays(world.db)).toBe(30);
  });

  it('a download that throws is reported in a fixed sentence and the choice stays saved', async () => {
    const world = await createSignedInWorld();
    const stack = stackWith(vi.fn(() => Promise.reject(new Error('secret detail'))));
    await open(world, { stack });
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent('The download did not finish. Try again.'));
    expect(screen.queryByText(/secret detail/)).toBeNull();
    expect(await readSyncDays(world.db)).toBe(7);
  });
});

describe('This device', () => {
  it('shows the server, the offline limit from the server and the last verification as a date', async () => {
    const world = await createSignedInWorld();
    await recordVerified(world.db, Date.UTC(2026, 9, 20, 12, 0, 0), 21);
    world.clock.set(Date.UTC(2026, 9, 22, 12, 0, 0));
    await open(world);
    expect(screen.getByTestId('settings-server')).toHaveTextContent(world.server.origin);
    await waitFor(() => expect(screen.getByTestId('settings-offline-limit')).toHaveTextContent('21 days'));
    const verified = screen.getByTestId('settings-last-verified');
    expect(verified).toHaveTextContent('October 20, 2026');
    expect(verified).toHaveTextContent('Checked 2 days ago');
  });

  it('says so when the device was never verified, and shows no invented limit', async () => {
    const world = await createSignedInWorld();
    await world.db.run("DELETE FROM device_state WHERE key IN ('last_verified_at', 'offline_max_days')");
    await open(world);
    await waitFor(() => expect(screen.getByTestId('settings-last-verified')).toHaveTextContent('Not verified yet'));
    expect(screen.getByTestId('settings-offline-limit')).toHaveTextContent('Not set');
  });

  it('shows what is waiting to upload and follows the database each time the poll fires', async () => {
    const world = await createSignedInWorld();
    const timers = createManualTimers();
    await open(world, { timers });
    await waitFor(() => expect(screen.getByTestId('settings-waiting')).toHaveTextContent('0 items'));
    await seedLocalData(world.db);
    await waitFor(() => expect(timers.pending()).toBe(1));
    timers.fireNext();
    await waitFor(() => expect(screen.getByTestId('settings-waiting')).toHaveTextContent('2 items'));
  });
});

describe('Open source', () => {
  it('names the licence, the version and the build date', async () => {
    const world = await createSignedInWorld();
    const services = { ...world.services, builtAt: '2026-10-20T08:30:00.000Z', appVersion: '1.4.2', openExternal: vi.fn(() => Promise.resolve()) };
    render(<Settings services={services} origin={world.server.origin} stack={null} locale="en-US" onBack={vi.fn()} onExport={vi.fn()} onSignedOut={vi.fn()} onCleared={vi.fn()} timers={createManualTimers()} />);
    const section = screen.getByRole('region', { name: 'Open source' });
    expect(section).toHaveTextContent('GNU Affero General Public License v3.0 (AGPL-3.0)');
    expect(screen.getByTestId('app-version')).toHaveTextContent('1.4.2');
    expect(screen.getByTestId('built-on')).toHaveTextContent('October 20, 2026');
  });

  it('shows an unknown build date as unknown, never as a made-up one', async () => {
    const world = await createSignedInWorld();
    const services = { ...world.services, builtAt: null };
    render(<Settings services={services} origin={world.server.origin} stack={null} onBack={vi.fn()} onExport={vi.fn()} onSignedOut={vi.fn()} onCleared={vi.fn()} timers={createManualTimers()} />);
    expect(screen.getByTestId('built-on')).toHaveTextContent('Unknown');
  });

  it('opens the source repository and the licence in the browser when tapped, and not before', async () => {
    const world = await createSignedInWorld();
    const { services } = await open(world);
    expect(services.openExternal).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Source code, opens in your browser' }));
    expect(services.openExternal).toHaveBeenCalledWith('https://github.com/InspectorHub/OpenInspection-App');
    await user.click(screen.getByRole('button', { name: 'Read the licence, opens in your browser' }));
    expect(services.openExternal).toHaveBeenLastCalledWith(LICENSE_URL);
    expect(SOURCE_URL).toBe('https://github.com/InspectorHub/OpenInspection-App');
  });

  it('a browser that cannot open the link gets a fixed sentence, not an error text', async () => {
    const world = await createSignedInWorld();
    const services = { ...world.services, openExternal: vi.fn(() => Promise.reject(new Error('intent://leak'))) };
    render(<Settings services={services} origin={world.server.origin} stack={null} onBack={vi.fn()} onExport={vi.fn()} onSignedOut={vi.fn()} onCleared={vi.fn()} timers={createManualTimers()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Source code, opens in your browser' }));
    expect(await screen.findByText(LINK_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/leak/)).toBeNull();
  });
});

describe('Delete account', () => {
  it('has no row while the server has not given an address (nothing is made up)', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.applyCompat(world.server.origin, compat({ accountUrl: null }));
    await open(world);
    expect(screen.queryByRole('button', { name: /delete account/i })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Account' })).getAllByRole('button')).toHaveLength(1);
  });

  it('shows the row when the server gave an https address, and opens exactly that page on tap', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.applyCompat(world.server.origin, compat({ accountUrl: 'https://accounts.example.test/privacy' }));
    const { services } = await open(world);
    expect(services.openExternal).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete account, opens in your browser' }));
    expect(services.openExternal).toHaveBeenCalledTimes(1);
    expect(services.openExternal).toHaveBeenCalledWith('https://accounts.example.test/privacy');
  });

  it('an address from another server does not appear for this one', async () => {
    const world = await createSignedInWorld();
    world.services.clientState.applyCompat('https://other.example.test', compat({ accountUrl: 'https://other.example.test/privacy' }));
    await open(world);
    expect(screen.queryByRole('button', { name: /delete account/i })).toBeNull();
  });
});
