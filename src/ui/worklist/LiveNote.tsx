/**
 * A polite live region that is always in the page (a region added together with its text is often not announced) but takes
 * no room while it is empty: empty it is screen-reader only, so it leaves the layout and no gap is reserved for it.
 */
export function LiveNote({ text, className, testId, visuallyHidden = false, reserve = false }: { text: string; className: string; testId?: string; visuallyHidden?: boolean; reserve?: boolean }) {
  // `reserve` keeps one line of height for a note that fills in later and sits above content, so that content does not move when the
  // note arrives. Empty, the line is blank; hidden, the text is announced from inside it.
  if (reserve) {
    return (
      <p aria-live="polite" data-testid={testId} className={`min-h-6 ${text === '' || visuallyHidden ? '' : className}`}>
        {visuallyHidden ? <span className="sr-only">{text}</span> : text}
      </p>
    );
  }
  // `visuallyHidden` keeps the announcement but takes no room: used while something else on screen already shows the state.
  return (
    <p aria-live="polite" data-testid={testId} className={text === '' || visuallyHidden ? 'sr-only' : className}>
      {text}
    </p>
  );
}
