/** The slice of the Capacitor `Keyboard` plugin the app uses. */
export interface KeyboardPort {
  addListener(event: 'keyboardWillShow', listener: (info: { keyboardHeight: number }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'keyboardWillHide', listener: () => void): Promise<{ remove(): Promise<void> }>;
}

/**
 * Keeps `--keyboard-height` on the root element equal to the height of the soft keyboard (0px when it is down). styles.css gives
 * #root that much padding at the bottom.
 *
 * Why: on iOS the keyboard covers the web view instead of shrinking it (capacitor.config.ts, `Keyboard.resize: 'none'`: shrinking it
 * flickered). A page that is exactly as tall as the screen then has nothing to scroll, so what the keyboard covers can never be
 * reached. With the padding the page is as much taller as the keyboard is, and iOS scrolls a covered field into view as well.
 * Android sizes the window itself and does not need this. Failures are dropped: in a browser during development there is no plugin.
 * Returns a function that stops following.
 */
export function followKeyboardInset(root: HTMLElement, keyboard: KeyboardPort): () => void {
  const set = (px: number): void => root.style.setProperty('--keyboard-height', `${px}px`);
  const handles: Array<Promise<{ remove(): Promise<void> }>> = [];
  try {
    handles.push(
      keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => {
        if (Number.isFinite(keyboardHeight) && keyboardHeight > 0) set(Math.round(keyboardHeight));
      }),
      keyboard.addListener('keyboardWillHide', () => set(0)),
    );
  } catch {
    return () => undefined;
  }
  for (const handle of handles) handle.catch(() => undefined);
  return () => {
    set(0);
    for (const handle of handles) void handle.then((h) => h.remove()).catch(() => undefined);
  };
}
