/** The slice of the Capacitor `Keyboard` plugin the app uses. */
export interface KeyboardPort {
  addListener(event: 'keyboardWillShow', listener: (info: { keyboardHeight: number }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'keyboardWillHide', listener: () => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'keyboardDidShow', listener: (info: { keyboardHeight: number }) => void): Promise<{ remove(): Promise<void> }>;
}

const CLEARANCE_PX = 12;

function isTextEntry(target: Element | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'image', 'color', 'hidden'].includes((target as HTMLInputElement).type);
  return target.isContentEditable;
}

function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Scrolls the focused text field clear of a keyboard that starts `keyboardTop` px from the top of the window. */
function clearOfKeyboard(doc: Document, keyboardTop: number): void {
  const field = doc.activeElement;
  if (!isTextEntry(field)) return;
  const overlap = field.getBoundingClientRect().bottom + CLEARANCE_PX - keyboardTop;
  if (overlap <= 0) return;
  if (scrollingAncestor(field)) field.scrollIntoView({ block: 'nearest' });
  else doc.defaultView?.scrollBy({ top: overlap });
}

/**
 * Keeps `--keyboard-height` on the root element equal to the height of the soft keyboard (0px when it is down). styles.css gives
 * #root that much padding at the bottom.
 *
 * Why: on iOS the keyboard covers the web view instead of shrinking it (capacitor.config.ts, `Keyboard.resize: 'none'`: shrinking it
 * flickered). A page that is exactly as tall as the screen then has nothing to scroll, so what the keyboard covers can never be
 * reached. With the padding the page is as much taller as the keyboard is, and iOS scrolls a covered field into view as well.
 * Android sizes the window itself and does not need this. Failures are dropped: in a browser during development there is no plugin.
 *
 * Once the keyboard is fully up, a focused text field that is still partly under it is scrolled clear of it. iOS does scroll a covered
 * field into view by itself, but it stops short: on an iPhone 12 a real tap on a field near the bottom left its last 25 px under the
 * keyboard (the page had room to scroll further, and reserving room before the keyboard rose changed nothing). The page knows exactly
 * where the keyboard starts, so it finishes the job. A field inside a scrolling dialog or sheet is brought into view by that
 * container, which already ends above the keyboard.
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
      keyboard.addListener('keyboardDidShow', ({ keyboardHeight }) => {
        const view = root.ownerDocument.defaultView;
        if (view && Number.isFinite(keyboardHeight) && keyboardHeight > 0) clearOfKeyboard(root.ownerDocument, view.innerHeight - Math.round(keyboardHeight));
      }),
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
