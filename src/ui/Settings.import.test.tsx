// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld } from '../app/test-support/world';
import { compat, open, stackWith } from './test-support/settings-world';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const IMPORT = { name: 'Import package' } as const;

/** Unavailable but still a real control: focusable and announced, its reason linked, its click ignored. */
function expectUnavailable(button: HTMLElement): void {
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).not.toBeDisabled();
  button.focus();
  expect(button).toHaveFocus();
}

function setLink(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

describe('Settings: import package', () => {
  it('sits right after Export unsent data, is enabled when sync is allowed, and hands the tap to the caller once', async () => {
    const world = await createSignedInWorld();
    const { onImport } = await open(world, { stack: stackWith() });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Import package')).toBe(buttons.indexOf('Export unsent data') + 1);
    const button = screen.getByRole('button', IMPORT);
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    await userEvent.setup().click(button);
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('offline: disabled, with the reason beside it (not hidden), and a tap does nothing', async () => {
    setLink(false);
    const world = await createSignedInWorld();
    const { onImport } = await open(world, { stack: stackWith() });
    const button = screen.getByRole('button', IMPORT);
    expectUnavailable(button);
    expect(screen.getByText('Connect to the internet to import a package.')).toBeVisible();
    expect(button).toHaveAccessibleDescription('Connect to the internet to import a package.');
    await userEvent.setup().click(button);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('comes back when the link does', async () => {
    setLink(false);
    const world = await createSignedInWorld();
    await open(world, { stack: stackWith() });
    expectUnavailable(screen.getByRole('button', IMPORT));
    act(() => {
      setLink(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('button', IMPORT)).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText('Connect to the internet to import a package.')).toBeNull();
  });

  it('a server that is too old: disabled, with its own reason', async () => {
    const world = await createSignedInWorld();
    const { services } = await open(world, { stack: stackWith() });
    act(() => services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true, serverContractVersion: 0 })));
    expectUnavailable(screen.getByRole('button', IMPORT));
    expect(screen.getByText(/older than the app expects/)).toBeVisible();
  });

  it('an update the server requires: disabled, and the reason says to update the app', async () => {
    const world = await createSignedInWorld();
    const { services } = await open(world, { stack: stackWith() });
    act(() => services.clientState.noteUpgrade(world.server.origin, 'required'));
    expectUnavailable(screen.getByRole('button', IMPORT));
    expect(screen.getByText('Update the app to import a package.')).toBeVisible();
  });

  it('where no session runs there is nothing to import into: disabled, with the reason', async () => {
    const world = await createSignedInWorld();
    await open(world);
    expectUnavailable(screen.getByRole('button', IMPORT));
    expect(screen.getByText('Sign in to import a package.')).toBeVisible();
  });

  it('control: a different server being too old does not switch this one off', async () => {
    const world = await createSignedInWorld();
    const { services } = await open(world, { stack: stackWith() });
    act(() => services.clientState.applyCompat('https://elsewhere.example.test', compat({ serverTooOld: true })));
    expect(screen.getByRole('button', IMPORT)).toBeEnabled();
  });
});
