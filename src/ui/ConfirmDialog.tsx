import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Button, Notice } from './kit';

export interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/** A modal that asks first: Cancel has focus, Escape and Cancel close it, Tab stays inside. Never `window.confirm`. */
export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = 'Cancel', busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

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
        className="flex w-full max-w-md flex-col gap-4 rounded-ih-modal border border-ih-border bg-ih-bg-card p-6 shadow-ih-popover"
      >
        <h2 id={titleId} className="font-ih-display text-xl font-bold tracking-tight text-ih-fg-1">
          {title}
        </h2>
        <p id={descriptionId} className="text-base leading-relaxed text-ih-fg-2">
          {description}
        </p>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex flex-col gap-3">
          <Button ref={confirmRef} disabled={busy} onClick={onConfirm}>
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
