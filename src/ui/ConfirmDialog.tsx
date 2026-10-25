import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Button, Notice } from './kit';

export interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as an action that cannot be undone. */
  destructive?: boolean;
  /** Extra content between the description and the error, such as the counts that will be lost. */
  details?: ReactNode;
  /** True while the confirm button must stay off for a reason other than a running action (the details are still loading). */
  confirmDisabled?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/** A modal that asks first: Cancel has focus, Escape and Cancel close it, Tab stays inside. Never `window.confirm`. */
export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = 'Cancel', destructive = false, details, confirmDisabled = false, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const opener = useRef<Element | null>(null);
  const fallback = useContext(DialogFocusFallback);

  useEffect(() => {
    // The button that opened the dialog is still the focused element here, just before Cancel takes focus.
    if (opener.current === null) opener.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      // Runs once the dialog is gone from the page. Focus the page moved elsewhere on purpose is left alone; focus that fell to
      // the body goes back to the opener, or to the fallback (the list's heading) when the opener no longer exists.
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus();
      else fallback?.current?.focus();
    };
  }, [fallback]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = confirmRef.current;
    const last = cancelRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ih-bg-app/80 p-4 md:items-center" onKeyDown={onKeyDown}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-ih-modal border border-ih-border bg-ih-bg-card p-6 shadow-ih-popover"
      >
        <h2 id={titleId} className="font-ih-display text-xl font-bold tracking-tight text-ih-fg-1">
          {title}
        </h2>
        <p id={descriptionId} className="text-base leading-relaxed text-ih-fg-2">
          {description}
        </p>
        {details}
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex flex-col gap-3">
          <Button ref={confirmRef} variant={destructive ? 'danger' : 'primary'} disabled={busy || confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where focus goes when a dialog closes and the button that opened it no longer exists, such as the list's heading. */
export const DialogFocusFallback = createContext<RefObject<HTMLElement | null> | null>(null);
