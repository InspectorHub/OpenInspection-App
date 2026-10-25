// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationAsk } from '../../app/notification-ask';
import { createMemoryKeyValue } from '../../platform/kv';
import type { NotificationPermissionPort, NotificationState } from '../../platform/notifications';
import { NOTIFICATIONS_OFF, NOTIFICATIONS_OPEN, NotificationsSection } from './NotificationsSection';

afterEach(cleanup);

function setup(initial: NotificationState, answer: NotificationState = 'granted') {
  let current = initial;
  const permission = {
    check: vi.fn(() => Promise.resolve(current)),
    request: vi.fn(() => {
      current = answer;
      return Promise.resolve(answer);
    }),
  } satisfies NotificationPermissionPort;
  const kv = createMemoryKeyValue();
  render(<NotificationsSection services={{ notifications: permission, notificationAsk: createNotificationAsk({ kv, permission }) }} />);
  return { permission, kv, set: (next: NotificationState) => (current = next) };
}

describe('NotificationsSection', () => {
  it('is not on the page where no permission is needed (iOS, a browser, a plugin that cannot answer)', async () => {
    const { permission } = setup('unsupported');
    await waitFor(() => expect(permission.check).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByRole('heading', { name: 'Notifications' })).toBeNull();
  });

  it('granted: says On, and offers nothing to press', async () => {
    setup('granted');
    expect(await screen.findByTestId('notification-state')).toHaveTextContent('On');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(NOTIFICATIONS_OFF)).toBeNull();
  });

  it('still open: says Off and the button shows the system prompt; the answer replaces the state', async () => {
    const { permission } = setup('prompt', 'granted');
    expect(await screen.findByText(NOTIFICATIONS_OPEN)).toBeInTheDocument();
    expect(screen.getByTestId('notification-state')).toHaveTextContent('Off');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(screen.getByTestId('notification-state')).toHaveTextContent('On'));
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refused by the system: says Off, points to Android Settings, and offers no button that cannot work', async () => {
    const { permission } = setup('denied');
    expect(await screen.findByText(NOTIFICATIONS_OFF)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(permission.request).not.toHaveBeenCalled();
  });

  it('reads the state again when the app becomes visible (a change made in Android Settings)', async () => {
    const { set } = setup('denied');
    expect(await screen.findByTestId('notification-state')).toHaveTextContent('Off');
    set('granted');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByTestId('notification-state')).toHaveTextContent('On'));
  });

  it('stops listening once it is gone', async () => {
    const { permission } = setup('prompt');
    await screen.findByTestId('notification-state');
    cleanup();
    const calls = permission.check.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(permission.check.mock.calls.length).toBe(calls);
  });
});
