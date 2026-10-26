// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalLink, LINK_FAILED } from './ExternalLink';

afterEach(cleanup);

describe('ExternalLink', () => {
  it('opens an https address on tap, normalised, and only then (control for the refusals below)', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    render(<ExternalLink services={{ openExternal }} url="https://Example.com/a b" label="Open" />);
    expect(openExternal).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a%20b');
  });

  it.each(['http://example.com/a', 'javascript:alert(1)', 'intent://x#Intent;end', 'file:///etc/passwd', 'https://user:pw@example.com/', '', null])('refuses %j before it reaches the browser', async (url) => {
    const openExternal = vi.fn(() => Promise.resolve());
    render(<ExternalLink services={{ openExternal }} url={url} label="Open" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(LINK_FAILED);
  });

  it('the failure message goes away on the next attempt that works', async () => {
    const openExternal = vi.fn().mockRejectedValueOnce(new Error('no browser')).mockResolvedValue(undefined);
    render(<ExternalLink services={{ openExternal }} url="https://example.com/" label="Open" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(LINK_FAILED);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is a plain row with no horizontal padding of its own (it lines up with the text above it), at least 44 px tall', () => {
    render(<ExternalLink services={{ openExternal: vi.fn() }} url="https://example.com/" label="Open" />);
    const classes = screen.getByRole('button', { name: 'Open' }).className;
    expect(classes).toContain('min-h-11');
    expect(classes).toContain('text-start');
    expect(classes.split(' ').filter((c) => c.startsWith('px-') || c.startsWith('p-'))).toEqual([]);
  });

  it('shows where it goes when it is given a host to show, in the name and on a visible line', () => {
    render(<ExternalLink services={{ openExternal: vi.fn() }} url="https://accounts.example.test/privacy" label="Delete account" showHost />);
    expect(screen.getByRole('button', { name: 'Delete account, opens accounts.example.test in your browser' })).toBeInTheDocument();
    expect(screen.getByText('Opens accounts.example.test in your browser')).toBeInTheDocument();
  });

  it('shows no host line by default, and none for an address it would refuse (control)', () => {
    render(<ExternalLink services={{ openExternal: vi.fn() }} url="https://accounts.example.test/privacy" label="Open" />);
    expect(screen.queryByText(/Opens/)).toBeNull();
    cleanup();
    render(<ExternalLink services={{ openExternal: vi.fn() }} url="http://accounts.example.test/privacy" label="Open" showHost />);
    expect(screen.queryByText(/Opens accounts/)).toBeNull();
  });

  it('two taps in one frame open one page', async () => {
    let release: () => void = () => undefined;
    const openExternal = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    render(<ExternalLink services={{ openExternal }} url="https://example.com/" label="Open" />);
    const button = screen.getByRole('button', { name: 'Open' });
    button.click();
    button.click();
    expect(openExternal).toHaveBeenCalledTimes(1);
    release();
  });
});
