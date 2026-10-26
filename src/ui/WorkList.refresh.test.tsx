// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshHalt, RefreshSummary } from '../offline/work-package';
import { fakeNetwork } from '../offline/test-support/replay-world';
import { refreshSummary, renderList } from './test-support/worklist-render';
import { at, createListWorld, seedPkg, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

const DOWNLOAD = { name: "Download today's work" };

function deferredSummary() {
  let resolve: (summary: RefreshSummary) => void = () => undefined;
  const promise = new Promise<RefreshSummary>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Download today\'s work', () => {
  it('asks the refresher for a manual run and shows what it did', async () => {
    const refresh = vi.spyOn(w.stack.refresher, 'refresh').mockResolvedValue(refreshSummary({ refreshed: 3 }));
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', DOWNLOAD));
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ reason: 'manual' });
    expect(await screen.findByText('Updated 3 inspections.')).toBeInTheDocument();
  });

  it('is busy while the run lasts, and two taps in one frame start one run', async () => {
    const gate = deferredSummary();
    const refresh = vi.spyOn(w.stack.refresher, 'refresh').mockReturnValue(gate.promise);
    renderList(w.stack);
    const button = await screen.findByRole('button', DOWNLOAD);
    button.click();
    button.click();
    await waitFor(() => expect(screen.getByRole('button', DOWNLOAD)).toHaveAttribute('aria-busy', 'true'));
    expect(refresh).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', DOWNLOAD));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(refreshSummary({ refreshed: 1 }));
      await gate.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', DOWNLOAD)).not.toHaveAttribute('aria-busy'));
    expect(await screen.findByText('Updated 1 inspection.')).toBeInTheDocument();
  });

  it('reads the list again when the run is over', async () => {
    vi.spyOn(w.stack.refresher, 'refresh').mockImplementation(async () => {
      await seedPkg(w.db, { id: 'fresh', scheduledAt: at(0) });
      return refreshSummary({ refreshed: 1 });
    });
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', DOWNLOAD));
    expect(await screen.findByTestId('row-fresh')).toBeInTheDocument();
  });

  it('the summary is a polite live region', async () => {
    renderList(w.stack);
    await screen.findByRole('button', DOWNLOAD);
    expect(screen.getByTestId('refresh-summary')).toHaveAttribute('aria-live', 'polite');
  });

  const SUMMARIES: [string, Partial<RefreshSummary>, string][] = [
    ['failures are counted', { refreshed: 2, failed: 1 }, 'Updated 2 inspections. 1 could not be downloaded.'],
    ['nothing new', {}, 'Everything is already up to date.'],
    ['storage is almost full', { refreshed: 1, cacheFull: true }, 'Updated 1 inspection. Storage is almost full.'],
    ['a download was skipped for storage', { skippedCacheFull: 2 }, 'Storage is almost full. 2 inspections were not downloaded.'],
    ['another step holds the lease', { leaseBusy: true }, 'Another sync step is running. Try again in a moment.'],
  ];
  it.each(SUMMARIES)('summary: %s', async (_name, patch, text) => {
    vi.spyOn(w.stack.refresher, 'refresh').mockResolvedValue(refreshSummary(patch));
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', DOWNLOAD));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  const HALTS: [RefreshHalt, string][] = [
    ['offline', 'You are offline. Connect to the internet to download.'],
    ['rate_limited', 'The server asked the app to slow down. Try again in a few minutes.'],
    ['upgrade_required', 'Update the app to keep syncing.'],
    ['auth', 'Sign in again to keep syncing.'],
    ['locked', 'The app is locked. Verify online first.'],
    ['list_failed', 'Could not get your list from the server. Try again.'],
    ['request_cap', 'The download stopped early. Try again.'],
    ['too_many_errors', 'The download stopped early. Try again.'],
    ['storage_failed', 'The download could not be saved. Free up storage and try again.'],
    ['lease_lost', 'The download did not finish. Try again.'],
    ['no_account', 'The download did not finish. Try again.'],
    ['stopped', 'The download did not finish. Try again.'],
  ];
  it.each(HALTS)('halt %s has its own fixed text', async (halted, text) => {
    vi.spyOn(w.stack.refresher, 'refresh').mockResolvedValue(refreshSummary({ halted }));
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', DOWNLOAD));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('a run that throws shows the fixed fallback, nothing from the error, and frees the button', async () => {
    vi.spyOn(w.stack.refresher, 'refresh').mockRejectedValue(new Error('secret token abc'));
    renderList(w.stack);
    await userEvent.setup().click(await screen.findByRole('button', DOWNLOAD));
    const line = await screen.findByText('The download did not finish. Try again.');
    expect(line.textContent).not.toContain('secret');
    expect(screen.getByRole('button', DOWNLOAD)).not.toHaveAttribute('aria-busy');
  });
});

describe('connection chip', () => {
  it('shows Online or Offline from the network port and follows its changes', async () => {
    const network = fakeNetwork(true);
    renderList(w.stack, { network });
    expect(await screen.findByText('Online')).toBeInTheDocument();
    act(() => {
      network.set(false);
    });
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    act(() => {
      network.set(true);
    });
    expect(await screen.findByText('Online')).toBeInTheDocument();
  });

  it('offline with data keeps showing the data', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack, { network: fakeNetwork(false) });
    expect(await screen.findByTestId('row-a')).toBeInTheDocument();
    expect(await screen.findByText('Offline')).toBeInTheDocument();
  });

  it('unsubscribes from the network port on unmount', async () => {
    const network = fakeNetwork(true);
    const view = renderList(w.stack, { network });
    await screen.findByText('Online');
    expect(network.listeners()).toBe(1);
    view.unmount();
    expect(network.listeners()).toBe(0);
  });
});
