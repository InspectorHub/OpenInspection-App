// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaRow } from '../../media/store';
import { CHECKING, CHECKING_AFTER_MS, CHECK_FAILED, REMOVE_DESCRIPTION, REMOVE_FAILED, UnreferencedPhotosSection } from './UnreferencedPhotosSection';

afterEach(cleanup);

const row = (pendingId: string): MediaRow => ({ pendingId, inspectionId: 'i1', kind: 'photo', path: `media/${pendingId}.jpg`, contentType: 'image/jpeg', meta: '{}', state: 'uploaded', attempts: 0, uploadedKey: `k/${pendingId}`, createdAt: 1 });

function fakes(initial: { uploaded: string[]; unreferenced: number }) {
  const state = { ...initial };
  const reconciler = {
    idle: vi.fn(() => Promise.resolve()),
    recheckMissing: vi.fn(),
    countUnreferenced: vi.fn(() => state.unreferenced),
    removeUnreferenced: vi.fn(() => {
      const removed = state.unreferenced;
      state.uploaded = state.uploaded.slice(removed);
      state.unreferenced = 0;
      return Promise.resolve({ removed, attached: 0, skipped: 0 });
    }),
  };
  const store = { listRows: vi.fn(() => Promise.resolve(state.uploaded.map(row))) };
  return { state, reconciler, store };
}

describe('UnreferencedPhotosSection', () => {
  it('is absent when no photo is waiting for its entry; control: it appears for one that is', async () => {
    const none = fakes({ uploaded: [], unreferenced: 0 });
    const view = render(<UnreferencedPhotosSection store={none.store} reconciler={none.reconciler} />);
    await waitFor(() => expect(none.store.listRows).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Photos not attached' })).toBeNull();
    view.unmount();
    const some = fakes({ uploaded: ['p1'], unreferenced: 0 });
    render(<UnreferencedPhotosSection store={some.store} reconciler={some.reconciler} />);
    expect(await screen.findByRole('region', { name: 'Photos not attached' })).toBeInTheDocument();
  });

  it('opening asks for one fresh look and reads the number only after it is over, from the stored rows', async () => {
    const f = fakes({ uploaded: ['p1', 'p2', 'p3'], unreferenced: 2 });
    const order: string[] = [];
    f.reconciler.recheckMissing.mockImplementation(() => order.push('recheck'));
    f.reconciler.idle.mockImplementation(() => {
      order.push('idle');
      return Promise.resolve();
    });
    f.store.listRows.mockImplementation(() => {
      order.push('read');
      return Promise.resolve([row('p1'), row('p2'), row('p3')]);
    });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const section = await screen.findByRole('region', { name: 'Photos not attached' });
    expect(order).toEqual(['recheck', 'idle', 'read']);
    expect(f.store.listRows).toHaveBeenCalledWith({ states: ['uploaded'] });
    expect(section).toHaveTextContent('3 photos or clips on this device are on the server but not attached to an inspection yet. 2 photos or clips could not be placed and can be removed.');
  });

  it('with nothing the last look found missing there is a recheck but no removal (control: with some, the removal is offered)', async () => {
    const f = fakes({ uploaded: ['p1'], unreferenced: 0 });
    const view = render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    await screen.findByRole('button', { name: 'Check again' });
    expect(screen.queryByRole('button', { name: /^Remove from/ })).toBeNull();
    view.unmount();
    const g = fakes({ uploaded: ['p1'], unreferenced: 1 });
    render(<UnreferencedPhotosSection store={g.store} reconciler={g.reconciler} />);
    expect(await screen.findByRole('button', { name: 'Remove from this device, 1 photo or clip' })).toBeInTheDocument();
  });

  it('Check again looks again and shows the new number', async () => {
    const f = fakes({ uploaded: ['p1', 'p2'], unreferenced: 1 });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    f.state.uploaded = ['p1'];
    f.state.unreferenced = 0;
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByRole('region')).toHaveTextContent('1 photo or clip on this device is on the server'));
    expect(screen.queryByRole('button', { name: /^Remove from/ })).toBeNull();
    expect(f.reconciler.recheckMissing).toHaveBeenCalledTimes(3);
  });

  it('removal asks first in a custom dialog; Cancel removes nothing; the confirmation removes and says how many', async () => {
    const f = fakes({ uploaded: ['p1', 'p2'], unreferenced: 2 });
    const confirm = vi.spyOn(window, 'confirm');
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Remove from this device, 2 photos or clips/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Remove 2 photos or clips from this device?');
    expect(dialog).toHaveAccessibleDescription(REMOVE_DESCRIPTION);
    expect(f.reconciler.removeUnreferenced).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(f.reconciler.removeUnreferenced).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Remove from this device, 2 photos or clips/ }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('unreferenced-note')).toHaveTextContent('Removed 2 photos or clips from this device.'));
    expect(f.reconciler.removeUnreferenced).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a double tap on the confirmation removes once', async () => {
    const f = fakes({ uploaded: ['p1'], unreferenced: 1 });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Remove from this device, 1 photo/ }));
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(f.reconciler.removeUnreferenced).toHaveBeenCalled());
    expect(f.reconciler.removeUnreferenced).toHaveBeenCalledTimes(1);
  });

  it('a removal that fails says so in a fixed sentence, keeps the dialog open and the photos', async () => {
    const f = fakes({ uploaded: ['p1'], unreferenced: 1 });
    f.reconciler.removeUnreferenced.mockRejectedValue(new Error('DISK-SECRET'));
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Remove from this device, 1 photo/ }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(REMOVE_FAILED);
    expect(screen.queryByText(/DISK-SECRET/)).toBeNull();
    expect(f.state.uploaded).toEqual(['p1']);
  });

  it('a check that fails says so in a fixed sentence and keeps the last number', async () => {
    const f = fakes({ uploaded: ['p1'], unreferenced: 0 });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    f.store.listRows.mockRejectedValue(new Error('DISK-SECRET'));
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(CHECK_FAILED);
    expect(screen.queryByText(/DISK-SECRET/)).toBeNull();
    expect(screen.getByRole('region')).toHaveTextContent('1 photo or clip on this device is on the server');
  });

  it('the note tells what was really done: removed, attached after all, and left', async () => {
    const f = fakes({ uploaded: ['p1', 'p2', 'p3'], unreferenced: 3 });
    f.reconciler.removeUnreferenced.mockResolvedValue({ removed: 1, attached: 1, skipped: 1 });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Remove from this device, 3/ }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByTestId('unreferenced-note')).toHaveTextContent('Removed 1 photo or clip from this device. 1 photo or clip could be attached to the inspection after all, so it was kept in it. 1 photo or clip could not be checked and was left on this device.'));
  });

  it('the accessible name of the removal button starts with its visible text', async () => {
    const f = fakes({ uploaded: ['p1'], unreferenced: 1 });
    render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
    const button = await screen.findByRole('button', { name: /^Remove from this device/ });
    const visible = (button.textContent ?? '').replace('…', '').trim();
    expect(visible).toBe('Remove from this device');
    expect(button.getAttribute('aria-label')?.startsWith(visible)).toBe(true);
  });

  it('a look that takes long says it is checking; nothing shows before that, and the line goes when the look ends', async () => {
    vi.useFakeTimers();
    try {
      const f = fakes({ uploaded: [], unreferenced: 0 });
      let finish: () => void = () => undefined;
      f.reconciler.idle.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      render(<UnreferencedPhotosSection store={f.store} reconciler={f.reconciler} />);
      expect(screen.queryByRole('status')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECKING_AFTER_MS + 1);
      });
      expect(screen.getByRole('status')).toHaveTextContent(CHECKING);
      await act(async () => {
        finish();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Photos not attached' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
