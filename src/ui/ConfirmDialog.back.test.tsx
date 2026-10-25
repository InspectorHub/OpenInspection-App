// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setHapticsPort } from '../platform/haptics';
import { createBackRegistry, pressBack } from './back-button';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(() => {
  cleanup();
  setHapticsPort(null);
});

const base = { title: 'T', description: 'D', confirmLabel: 'Go', busy: false, error: null, onConfirm: () => undefined, onCancel: () => undefined };

describe('ConfirmDialog and the back key', () => {
  it('a back press closes the dialog through Cancel and does not leave the app', () => {
    const onCancel = vi.fn();
    const exit = vi.fn();
    render(<ConfirmDialog {...base} onCancel={onCancel} />);
    act(() => pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('while an action runs the press is used up but the dialog stays (control: the same press cancels once idle)', () => {
    const onCancel = vi.fn();
    const exit = vi.fn();
    const view = render(<ConfirmDialog {...base} busy onCancel={onCancel} />);
    act(() => pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    view.rerender(<ConfirmDialog {...base} onCancel={onCancel} />);
    act(() => pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a real Escape key inside the dialog cancels once, not twice', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} onCancel={onCancel} />);
    await userEvent.setup().keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmDialog haptics', () => {
  it('confirming a destructive action vibrates once (control: an ordinary confirm does not)', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const user = userEvent.setup();
    const view = render(<ConfirmDialog {...base} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(notify).not.toHaveBeenCalled();
    view.rerender(<ConfirmDialog {...base} destructive />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('warning');
  });

  it('cancelling a destructive dialog does not vibrate', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    render(<ConfirmDialog {...base} destructive />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(notify).not.toHaveBeenCalled();
  });
});
