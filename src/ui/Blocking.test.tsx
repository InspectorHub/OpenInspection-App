// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenFailed } from './Blocking';

afterEach(() => { cleanup(); delete window.oiDesktop; });

describe('OpenFailed', () => {
  it('offers only the safe exit until old data movement is explicitly confirmed', async () => {
    const user = userEvent.setup();
    const setAsideUnreadable = vi.fn(async () => undefined);
    window.oiDesktop = { apiVersion: 1, db: { setAsideUnreadable } } as never;
    render(<OpenFailed reason="key-unreadable" />);
    expect(screen.getByText('This Windows account cannot unlock the data stored on this computer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quit' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set the old data aside and start fresh' }));
    expect(setAsideUnreadable).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set old data aside' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setAsideUnreadable).not.toHaveBeenCalled();
  });

  it.each([
    ['encryption-unavailable', 'Database encryption is unavailable on this computer. Your data has not been changed.'],
    ['corrupt', 'The local data could not be read. Your data has not been changed.'],
  ] as const)('offers the data folder for %s without exposing system details', async (reason, sentence) => {
    const openDataFolder = vi.fn(async () => undefined);
    window.oiDesktop = { apiVersion: 1, shell: { openDataFolder } } as never;
    const user = userEvent.setup();
    render(<OpenFailed reason={reason} />);
    expect(screen.getByText(sentence)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open data folder' }));
    expect(openDataFolder).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/C:\\|Error:|ENOENT/);
  });
});
