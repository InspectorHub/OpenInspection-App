// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

const base = { title: 'T', description: 'D', confirmLabel: 'Go', busy: false, error: null, onConfirm: () => undefined, onCancel: () => undefined };

describe('ConfirmDialog extras', () => {
  it('is an ordinary primary action by default', () => {
    render(<ConfirmDialog {...base} />);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('bg-ih-primary');
    expect(screen.getByRole('button', { name: 'Go' }).className).not.toContain('bg-ih-bad');
  });

  it('destructive styles the confirm button with the bad token and leaves Cancel alone', () => {
    render(<ConfirmDialog {...base} destructive />);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('bg-ih-bad');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).not.toContain('bg-ih-bad');
  });

  it('shows details between the description and the error', () => {
    render(<ConfirmDialog {...base} details={<p>Counts here</p>} error="Went wrong" />);
    const description = screen.getByText('D');
    const details = screen.getByText('Counts here');
    const error = screen.getByText('Went wrong');
    expect(description.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('confirmDisabled keeps the confirm button off while Cancel works', () => {
    render(<ConfirmDialog {...base} confirmDisabled />);
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('scrolls inside the screen when the content is tall', () => {
    render(<ConfirmDialog {...base} />);
    expect(screen.getByRole('alertdialog').className).toContain('overflow-y-auto');
  });
});
