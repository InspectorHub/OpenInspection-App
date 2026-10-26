/**
 * A polite live region that is always in the page (a region added together with its text is often not announced) but takes
 * no room while it is empty: empty it is screen-reader only, so it leaves the layout and no gap is reserved for it.
 */
export function LiveNote({ text, className, testId }: { text: string; className: string; testId?: string }) {
  return (
    <p aria-live="polite" data-testid={testId} className={text === '' ? 'sr-only' : className}>
      {text}
    </p>
  );
}
