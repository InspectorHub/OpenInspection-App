// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialog, DialogFocusFallback } from './ConfirmDialog';

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

/** An opener button, a dialog it opens, and optionally a second button that the dialog's confirm removes from the page. */
function Harness({ removeOpenerOnConfirm = false, fallback = false }: { removeOpenerOnConfirm?: boolean; fallback?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerGone, setOpenerGone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = (
    <div>
      <h1 ref={heading} tabIndex={-1}>
        List heading
      </h1>
      {!openerGone && <button onClick={() => setOpen(true)}>Open it</button>}
      {open && (
        <ConfirmDialog
          {...base}
          onConfirm={() => {
            setOpen(false);
            if (removeOpenerOnConfirm) setOpenerGone(true);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
  return fallback ? <DialogFocusFallback value={heading}>{page}</DialogFocusFallback> : page;
}

describe('ConfirmDialog returns focus to the button that opened it', () => {
  it('Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open it' })).toHaveFocus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open it' }));
  });

  it('Cancel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open it' }));
  });

  it('a confirm that closes it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open it' }));
  });

  it('when the opener is gone afterwards, focus goes to the fallback heading', async () => {
    const user = userEvent.setup();
    render(<Harness removeOpenerOnConfirm fallback />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open it' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'List heading' }));
  });

  it('when the opener is gone and there is no fallback, nothing throws and focus is not left on a removed element', async () => {
    const user = userEvent.setup();
    render(<Harness removeOpenerOnConfirm />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(document.activeElement).toBe(document.body);
  });

  it('does not steal focus the page moved on purpose before the dialog went away', async () => {
    const user = userEvent.setup();
    function Moves() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button onClick={() => setOpen(true)}>Open it</button>
          <input aria-label="elsewhere" />
          {open && (
            <ConfirmDialog
              {...base}
              onConfirm={() => {
                screen.getByLabelText('elsewhere').focus();
                setOpen(false);
              }}
            />
          )}
        </div>
      );
    }
    render(<Moves />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(document.activeElement).toBe(screen.getByLabelText('elsewhere'));
  });
});
