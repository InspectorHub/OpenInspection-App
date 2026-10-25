// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../../app/offline-stack';
import { createSignedInWorld } from '../../app/test-support/world';
import type { Db } from '../../platform/db';
import type { RefreshSummary } from '../../offline/work-package';
import { readSyncDays } from '../../offline/work-package';
import { refreshSummary } from '../test-support/worklist-render';
import { SAVE_FAILED, SyncSection } from './SyncSection';

afterEach(cleanup);

describe('SyncSection: a save that fails', () => {
  it('says so in a fixed sentence, starts no download, keeps the old choice, and writes nothing', async () => {
    const world = await createSignedInWorld();
    const failing: Db = { ...world.db, run: (sql, params) => (/device_state/.test(sql) && String(params?.[0]) === 'sync_days' ? Promise.reject(new Error('disk secret')) : world.db.run(sql, params)) };
    const refresh = vi.fn(() => Promise.resolve(refreshSummary()));
    const stack = { refresher: { refresh } } as unknown as OfflineStack;
    render(<SyncSection services={{ db: failing }} stack={stack} canSync />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '14 days' })).toBeChecked());
    await userEvent.setup().click(screen.getByRole('radio', { name: '30 days' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.queryByText(/disk secret/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: '14 days' })).toBeChecked();
    expect(screen.getByTestId('sync-note')).toHaveTextContent('');
    expect(await readSyncDays(world.db)).toBe(14);
  });

  it('the notice goes away on the next successful choice (control)', async () => {
    const world = await createSignedInWorld();
    let fail = true;
    const flaky: Db = { ...world.db, run: (sql, params) => (fail && /device_state/.test(sql) ? Promise.reject(new Error('x')) : world.db.run(sql, params)) };
    render(<SyncSection services={{ db: flaky }} stack={null} canSync />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('radio', { name: '7 days' })).toBeChecked();
  });
});

describe('SyncSection: quick changes', () => {
  it('a choice made while a download runs gets one more download after it, so the last choice is the one used', async () => {
    const world = await createSignedInWorld();
    const releases: Array<(summary: RefreshSummary) => void> = [];
    const seen: number[] = [];
    const refresh = vi.fn(async () => {
      seen.push(await readSyncDays(world.db));
      return new Promise<RefreshSummary>((resolve) => releases.push(resolve));
    });
    const stack = { refresher: { refresh } } as unknown as OfflineStack;
    render(<SyncSection services={{ db: world.db }} stack={stack} canSync />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(releases.length).toBe(1));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => releases[0]?.(refreshSummary({ refreshed: 1 })));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(releases.length).toBe(2));
    expect(seen).toEqual([30, 7]);
    await act(async () => releases[1]?.(refreshSummary({ refreshed: 2 })));
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent('Updated 2 inspections.'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('without a quick second choice there is exactly one download per choice (control)', async () => {
    const world = await createSignedInWorld();
    const refresh = vi.fn(() => Promise.resolve(refreshSummary()));
    const stack = { refresher: { refresh } } as unknown as OfflineStack;
    render(<SyncSection services={{ db: world.db }} stack={stack} canSync />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('a download that fails does not stop the queued one, and the note shows the fixed sentence', async () => {
    const world = await createSignedInWorld();
    const releases: Array<{ resolve: (s: RefreshSummary) => void; reject: (e: Error) => void }> = [];
    const refresh = vi.fn(() => new Promise<RefreshSummary>((resolve, reject) => releases.push({ resolve, reject })));
    const stack = { refresher: { refresh } } as unknown as OfflineStack;
    render(<SyncSection services={{ db: world.db }} stack={stack} canSync />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '7 days' })).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await act(async () => releases[0]?.reject(new Error('boom')));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await act(async () => releases[1]?.reject(new Error('boom')));
    await waitFor(() => expect(screen.getByTestId('sync-note')).toHaveTextContent('The download did not finish. Try again.'));
  });
});
