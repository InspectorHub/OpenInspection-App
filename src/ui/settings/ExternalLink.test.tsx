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
