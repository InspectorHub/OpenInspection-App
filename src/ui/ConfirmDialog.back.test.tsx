// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { setHapticsPort } from '../platform/haptics';
import { createBackRegistry, pressBack } from './back-button';
import { BUSY_WATCHDOG_MS, ConfirmDialog } from './ConfirmDialog';
import { ExportResult } from './ExportResult';

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

describe('a dialog whose action never settles', () => {
  it('holds the person for the watchdog time, then lets Cancel and the back key work again while the action carries on', () => {
    const timers = createManualTimers();
    const onCancel = vi.fn();
    const exit = vi.fn();
    render(<ConfirmDialog {...base} busy timers={timers} onCancel={onCancel} />);
    expect(timers.delays()).toEqual([BUSY_WATCHDOG_MS]);
    expect(BUSY_WATCHDOG_MS).toBe(30_000);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    act(() => pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window }));
    expect(exit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    act(() => timers.fireNext());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
    act(() => pressBack(createBackRegistry(), { exitApp: exit, escapeTarget: window }));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a stuck dialog can be cancelled with its button', async () => {
    const timers = createManualTimers();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} busy timers={timers} onCancel={onCancel} />);
    act(() => timers.fireNext());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('an action that settles in time never trips the watchdog, and a new busy period starts a new count', () => {
    const timers = createManualTimers();
    const view = render(<ConfirmDialog {...base} busy timers={timers} />);
    view.rerender(<ConfirmDialog {...base} busy={false} timers={timers} />);
    expect(timers.pending()).toBe(0);
    view.rerender(<ConfirmDialog {...base} busy timers={timers} />);
    expect(timers.pending()).toBe(1);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('removes its timer when it goes away', () => {
    const timers = createManualTimers();
    const view = render(<ConfirmDialog {...base} busy timers={timers} />);
    view.unmount();
    expect(timers.pending()).toBe(0);
  });
});

describe('the overlay', () => {
  it('uses the theme backdrop, not the app background at partial opacity, and keeps clear of the gesture bar', () => {
    const view = render(<ConfirmDialog {...base} />);
    const overlay = view.container.querySelector('.fixed') ?? document.querySelector('.fixed');
    expect(overlay?.className).toContain('bg-ih-backdrop');
    expect(overlay?.className).not.toContain('bg-ih-bg-app');
    expect(overlay?.className).toContain('safe-pad');
    cleanup();
    render(<ExportResult title="T" onClose={() => undefined}>x</ExportResult>);
    const result = document.querySelector('.fixed');
    expect(result?.className).toContain('bg-ih-backdrop');
    expect(result?.className).toContain('safe-pad');
  });
});
