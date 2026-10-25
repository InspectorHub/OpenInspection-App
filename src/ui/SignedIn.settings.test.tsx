// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationAsk, ASK_KEY } from '../app/notification-ask';
import { createSignedInWorld, seedLocalData, type World } from '../app/test-support/world';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createMemoryKeyValue } from '../platform/kv';
import type { NotificationPermissionPort, NotificationState } from '../platform/notifications';
import { backRegistry, pressBack } from './back-button';
import { SignedIn } from './SignedIn';

afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

function permission(initial: NotificationState, answer: NotificationState = 'granted') {
  let current = initial;
  const port = {
    check: vi.fn(() => Promise.resolve(current)),
    request: vi.fn(() => {
      current = answer;
      return Promise.resolve(answer);
    }),
  };
  return port satisfies NotificationPermissionPort;
}

function mount(world: World, port: NotificationPermissionPort = permission('unsupported'), initial: Record<string, string> = {}) {
  const kv = createMemoryKeyValue(initial);
  const services = { ...world.services, notifications: port, notificationAsk: createNotificationAsk({ kv, permission: port }) };
  const onSignedOut = vi.fn();
  const timers = createManualTimers();
  render(<SignedIn services={services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} timers={timers} />);
  return { kv, onSignedOut, timers, services };
}

describe('SignedIn and Settings', () => {
  it('Settings opens from the home screen and Back returns to it with focus on the button that opened it', async () => {
    const world = await createSignedInWorld();
    mount(world);
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Work list' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to work list' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus();
  });

  it('the system back key leaves Settings for the list, and from the list it leaves the app', async () => {
    const world = await createSignedInWorld();
    mount(world);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
    const exit = vi.fn();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    expect(screen.getByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(exit).not.toHaveBeenCalled();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('Export from Settings opens the export question over Settings, and closing it returns to Settings', async () => {
    const world = await createSignedInWorld();
    mount(world);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Export unsent data' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('signing out from Settings reports to the app once', async () => {
    const world = await createSignedInWorld();
    const { onSignedOut } = mount(world);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });
});

describe('the notification question', () => {
  it('is asked when something first waits to upload: our explanation first, then the system prompt once, and never again', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const port = permission('prompt', 'granted');
    const { kv } = mount(world, port);
    const dialog = await screen.findByRole('alertdialog', { name: 'Show upload progress?' });
    expect(port.request).not.toHaveBeenCalled();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Allow notifications' }));
    await waitFor(() => expect(port.request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kv.entries()[ASK_KEY]).toBe('asked');
    cleanup();
    mount(world, port, kv.entries());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(port.request).toHaveBeenCalledTimes(1);
  });

  it('"Not now" shows no system prompt and is remembered', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const port = permission('prompt');
    const { kv } = mount(world, port);
    const dialog = await screen.findByRole('alertdialog', { name: 'Show upload progress?' });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(port.request).not.toHaveBeenCalled();
    expect(kv.entries()[ASK_KEY]).toBe('declined');
  });

  it('is not asked when nothing is waiting (control: the same device asks as soon as something is)', async () => {
    const world = await createSignedInWorld();
    const port = permission('prompt');
    const { timers } = mount(world, port);
    await waitFor(() => expect(timers.pending()).toBe(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await seedLocalData(world.db);
    await act(async () => timers.fireNext());
    expect(await screen.findByRole('alertdialog', { name: 'Show upload progress?' })).toBeInTheDocument();
  });

  it('is asked after the first export closes, and waits while the export question is open', async () => {
    const world = await createSignedInWorld();
    const port = permission('prompt');
    mount(world, port);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export unsent data' }));
    const exportDialog = await screen.findByRole('alertdialog');
    expect(exportDialog).toHaveAccessibleName(/export/i);
    expect(screen.queryByRole('alertdialog', { name: 'Show upload progress?' })).toBeNull();
    await user.click(within(exportDialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog', { name: 'Show upload progress?' })).toBeInTheDocument();
  });

  it.each<NotificationState>(['granted', 'denied', 'unsupported'])('is never asked when the system already answered (%s)', async (state) => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const port = permission(state);
    mount(world, port);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export unsent data' }));
    await userEvent.setup().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(port.request).not.toHaveBeenCalled();
  });
});
