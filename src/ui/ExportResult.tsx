import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './kit';

export interface ExportResultProps {
  title: string;
  /** The notices and sentences of the result, already composed. */
  children: ReactNode;
  onClose(): void;
}

/** What the person reads after an export: a single-button modal. Escape and Close both leave; focus starts on Close. */
export function ExportResult({ title, children, onClose }: ExportResultProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ih-bg-app/80 p-4 md:items-center" onKeyDown={onKeyDown}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-ih-modal border border-ih-border bg-ih-bg-card p-6 shadow-ih-popover">
        <h2 id={titleId} className="font-ih-display text-xl font-bold tracking-tight text-ih-fg-1">
          {title}
        </h2>
        <div className="flex flex-col gap-3">{children}</div>
        <Button ref={closeRef} onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
