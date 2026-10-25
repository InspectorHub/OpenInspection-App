// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationAsk } from '../app/notification-ask';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import { createMemoryKeyValue } from '../platform/kv';
import { createNotificationPermission } from '../platform/notifications';
import { SignedIn } from './SignedIn';
import { createListWorld, seedMedia, seedPkg } from './test-support/worklist-world';

afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

async function mountOverList(display: string, platform: 'android' | 'ios') {
  const world = await createSignedInWorld();
  const list = await createListWorld();
  await seedPkg(list.db, { id: 'i1' });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await seedMedia(list.db, id, 'i1', 'pending');
  const plugin = { checkPermissions: vi.fn(() => Promise.resolve({ display })), requestPermissions: vi.fn(() => Promise.resolve({ display: 'granted' })) };
  const permission = createNotificationPermission(plugin, platform);
  const kv = createMemoryKeyValue();
  const services = { ...world.services, db: list.db, notifications: permission, notificationAsk: createNotificationAsk({ kv, permission }) };
  render(
    <OfflineStackContext.Provider value={list.stack}>
      <SignedIn services={services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
    </OfflineStackContext.Provider>,
  );
  return { plugin, kv };
}

describe('the notification explanation over the real work list and the real permission mapping', () => {
  it.each(['prompt', 'prompt-with-rationale'])('shows when six photos wait to upload and Android reports %s', async (display) => {
    await mountOverList(display, 'android');
    expect(await screen.findByRole('alertdialog', { name: 'Show upload progress?' }, { timeout: 5000 })).toBeInTheDocument();
  });

  it.each(['granted', 'denied'])('never shows when Android already answered (%s), with the same six photos waiting', async (display) => {
    const { plugin } = await mountOverList(display, 'android');
    await waitFor(() => expect(plugin.checkPermissions).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('never shows on iOS, and never asks the plugin there', async () => {
    const { plugin } = await mountOverList('prompt', 'ios');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(plugin.checkPermissions).not.toHaveBeenCalled();
  });

  it('"Not now" records declined and the explanation does not come back after a fresh mount of the same device', async () => {
    const { kv } = await mountOverList('prompt', 'android');
    const dialog = await screen.findByRole('alertdialog', { name: 'Show upload progress?' }, { timeout: 5000 });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(kv.entries()['oi.notification-ask']).toBe('declined');
  });
});
