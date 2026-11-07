// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followKeyboardInset, type KeyboardPort } from './keyboard-inset';

function fakeKeyboard() {
  const listeners: Record<string, (info?: { keyboardHeight: number }) => void> = {};
  const remove = vi.fn(() => Promise.resolve());
  const port: KeyboardPort = {
    addListener: ((event: string, listener: (info?: { keyboardHeight: number }) => void) => {
      listeners[event] = listener;
      return Promise.resolve({ remove });
    }) as KeyboardPort['addListener'],
  };
  return { port, listeners, remove };
}

const value = (root: HTMLElement): string => root.style.getPropertyValue('--keyboard-height');

describe('followKeyboardInset', () => {
  it('sets the keyboard height when the keyboard is about to show and zero when it hides', () => {
    const root = document.createElement('div');
    const { port, listeners } = fakeKeyboard();
    followKeyboardInset(root, port);
    listeners['keyboardWillShow']?.({ keyboardHeight: 336 });
    expect(value(root)).toBe('336px');
    listeners['keyboardWillHide']?.();
    expect(value(root)).toBe('0px');
  });

  it('ignores a height that is not a positive number', () => {
    const root = document.createElement('div');
    const { port, listeners } = fakeKeyboard();
    followKeyboardInset(root, port);
    listeners['keyboardWillShow']?.({ keyboardHeight: 336 });
    for (const bad of [Number.NaN, -20, 0, Number.POSITIVE_INFINITY]) {
      listeners['keyboardWillShow']?.({ keyboardHeight: bad });
      expect(value(root)).toBe('336px');
    }
  });

  it('stops following: resets to zero and removes its listeners', async () => {
    const root = document.createElement('div');
    const { port, listeners, remove } = fakeKeyboard();
    const stop = followKeyboardInset(root, port);
    listeners['keyboardWillShow']?.({ keyboardHeight: 300 });
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(value(root)).toBe('0px');
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('does nothing and does not throw when there is no plugin', () => {
    const root = document.createElement('div');
    const port: KeyboardPort = { addListener: () => { throw new Error('no plugin'); } };
    expect(() => followKeyboardInset(root, port)()).not.toThrow();
    expect(value(root)).toBe('');
  });
});

describe('a focused field that is still under the keyboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const WINDOW_HEIGHT = 844;
  const KEYBOARD = 329;

  const focusedField = (bottom: number): HTMLInputElement => {
    const el = document.createElement('input');
    document.body.append(el);
    el.focus();
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ bottom, top: bottom - 36, left: 0, right: 100, width: 100, height: 36, x: 0, y: bottom - 36, toJSON: () => ({}) });
    return el;
  };
  const setup = () => {
    Object.defineProperty(window, 'innerHeight', { value: WINDOW_HEIGHT, configurable: true });
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    const { port, listeners } = fakeKeyboard();
    const stop = followKeyboardInset(document.documentElement, port);
    return { scrollBy, listeners, stop };
  };

  it('is scrolled up by exactly what the keyboard covers, plus a little room, once the keyboard is fully up', () => {
    const { scrollBy, listeners, stop } = setup();
    focusedField(540); // the keyboard starts at 844 - 329 = 515
    listeners['keyboardDidShow']?.({ keyboardHeight: KEYBOARD });
    expect(scrollBy).toHaveBeenCalledWith({ top: 540 + 12 - 515 });
    stop();
  });

  it('is left alone when it is already clear of the keyboard', () => {
    const { scrollBy, listeners, stop } = setup();
    focusedField(440);
    listeners['keyboardDidShow']?.({ keyboardHeight: KEYBOARD });
    expect(scrollBy).not.toHaveBeenCalled();
    stop();
  });

  it('is left alone when what has focus is not a text field', () => {
    const { scrollBy, listeners, stop } = setup();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ bottom: 800, top: 760, left: 0, right: 10, width: 10, height: 40, x: 0, y: 760, toJSON: () => ({}) });
    listeners['keyboardDidShow']?.({ keyboardHeight: KEYBOARD });
    expect(scrollBy).not.toHaveBeenCalled();
    stop();
  });

  it('ignores a keyboard height that is not a positive number', () => {
    const { scrollBy, listeners, stop } = setup();
    focusedField(800);
    for (const bad of [Number.NaN, 0, -5]) listeners['keyboardDidShow']?.({ keyboardHeight: bad });
    expect(scrollBy).not.toHaveBeenCalled();
    stop();
  });
});
