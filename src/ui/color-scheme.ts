/** The slice of `MediaQueryList` the scheme follows. */
export interface SchemeQuery {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
}

/**
 * The field-ui theme swaps its tokens on `html[data-color-scheme]`, not on the media query, so
 * the device's light/dark setting is copied onto that attribute and kept in step. Returns a stop function.
 */
export function followSystemColorScheme(root: HTMLElement, query: SchemeQuery): () => void {
  const apply = (dark: boolean): void => {
    root.dataset.colorScheme = dark ? 'dark' : 'light';
  };
  const listener = (event: { matches: boolean }): void => apply(event.matches);
  apply(query.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
