// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_KEY, createNotificationAsk } from '../app/notification-ask';
import { createSignedInWorld, seedLocalData } from '../app/test-support/world';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createMemoryKeyValue } from '../platform/kv';
import type { NotificationPermissionPort } from '../platform/notifications';
import { backRegistry, pressBack } from './back-button';
import { NotificationPrompt } from './NotificationPrompt';
import { escapeLayerCount } from './escape-layer';

afterEach(cleanup);

function port(request: () => Promise<'granted' | 'denied'> = () => Promise.resolve('granted')): NotificationPermissionPort & { request: ReturnType<typeof vi.fn> } {
  return { check: vi.fn(() => Promise.resolve('prompt' as const)), request: vi.fn(request) } as never;
}

describe('NotificationPrompt', () => {
  it('waits while another dialog is open, even with uploads waiting, and shows once the way is clear', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const kv = createMemoryKeyValue();
    const permission = port();
    const services = { db: world.db, notificationAsk: createNotificationAsk({ kv, permission }) };
    const timers = createManualTimers();
    const view = render(<NotificationPrompt services={services} exportsClosed={0} suspended timers={timers} />);
    await waitFor(() => expect(timers.pending()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(permission.request).not.toHaveBeenCalled();
    view.rerender(<NotificationPrompt services={services} exportsClosed={0} suspended={false} timers={timers} />);
    expect(await screen.findByRole('alertdialog', { name: 'Show upload progress?' })).toBeInTheDocument();
  });

  it('a system prompt that cannot be shown still closes the question for good', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const kv = createMemoryKeyValue();
    const permission = port(() => Promise.reject(new Error('no activity')));
    const services = { db: world.db, notificationAsk: createNotificationAsk({ kv, permission }) };
    render(<NotificationPrompt services={services} exportsClosed={0} suspended={false} timers={createManualTimers()} />);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Allow notifications' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(permission.request).toHaveBeenCalledTimes(1);
  });

  it('the back key on the explanation is "Not now": remembered, and no system prompt', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const kv = createMemoryKeyValue();
    const permission = port();
    const services = { db: world.db, notificationAsk: createNotificationAsk({ kv, permission }) };
    const layersBefore = escapeLayerCount();
    render(<NotificationPrompt services={services} exportsClosed={0} suspended={false} timers={createManualTimers()} />);
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(escapeLayerCount()).toBe(layersBefore + 1));
    const exit = vi.fn();
    act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(escapeLayerCount()).toBe(layersBefore);
    });
    expect(kv.entries()[ASK_KEY]).toBe('declined');
    expect(permission.request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
