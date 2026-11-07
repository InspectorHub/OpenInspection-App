// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from '../app/test-support/world';
import { backRegistry } from './back-button';
import { ConfirmDialog } from './ConfirmDialog';
import { ExportResult } from './ExportResult';
import { BackLink } from './kit';
import { ServerSetup } from './ServerSetup';

afterEach(cleanup);

const confirmProps = { title: 'T', description: 'D', confirmLabel: 'Go', busy: false, error: null, onConfirm: () => undefined };

describe('how a surface is left', () => {
  it('BackLink is a worded control of at least 44px whose spoken name contains the visible text', () => {
    render(<BackLink label="Work list" ariaLabel="Back to work list" onClick={() => undefined} />);
    const back = screen.getByRole('button', { name: 'Back to work list' });
    expect(back.textContent).toContain('Work list');
    expect(back.className).toContain('min-h-11');
  });

  it('a tap on the backdrop cancels a confirm, a tap inside does not', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...confirmProps} onCancel={onCancel} />);
    await userEvent.setup().click(screen.getByText('D'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('alertdialog').parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a tap on the backdrop does nothing while the confirmed action runs', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...confirmProps} busy onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('alertdialog').parentElement as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a result dialog has one visible Close, and the backdrop closes it too', async () => {
    const onClose = vi.fn();
    render(
      <ExportResult title="Export finished" onClose={onClose}>
        <p>All sent.</p>
      </ExportResult>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the server address reached from sign-in has a way back, on screen and on the back key', async () => {
    const world = await createWorld();
    const onBack = vi.fn();
    render(<ServerSetup services={world.services} onConnected={vi.fn()} onBack={onBack} devHttpSwitch={false} initialUrl="" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(backRegistry.screens()[0]?.()).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('a first-run server setup has nothing to go back to', async () => {
    const world = await createWorld();
    render(<ServerSetup services={world.services} onConnected={vi.fn()} devHttpSwitch={false} initialUrl="" />);
    expect(screen.queryByRole('button', { name: 'Back to sign in' })).toBeNull();
  });
});
