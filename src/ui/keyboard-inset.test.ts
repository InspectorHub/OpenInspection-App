import { describe, expect, it, vi } from 'vitest';
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

  it('stops following: resets to zero and removes both listeners', async () => {
    const root = document.createElement('div');
    const { port, listeners, remove } = fakeKeyboard();
    const stop = followKeyboardInset(root, port);
    listeners['keyboardWillShow']?.({ keyboardHeight: 300 });
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(value(root)).toBe('0px');
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('does nothing and does not throw when there is no plugin', () => {
    const root = document.createElement('div');
    const port: KeyboardPort = { addListener: () => { throw new Error('no plugin'); } };
    expect(() => followKeyboardInset(root, port)()).not.toThrow();
    expect(value(root)).toBe('');
  });
});
