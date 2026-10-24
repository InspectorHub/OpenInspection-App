// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { followSystemColorScheme, type SchemeQuery } from './color-scheme';

function fakeQuery(matches: boolean): SchemeQuery & { flip(next: boolean): void; listeners: number } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches,
    addEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
    flip: (next: boolean) => {
      query.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
    get listeners() {
      return listeners.size;
    },
  };
  return query;
}

describe('followSystemColorScheme', () => {
  it('sets the attribute the theme swaps its tokens on, and follows the device', () => {
    const root = document.createElement('html');
    const query = fakeQuery(true);
    followSystemColorScheme(root, query);
    expect(root.dataset.colorScheme).toBe('dark');
    query.flip(false);
    expect(root.dataset.colorScheme).toBe('light');
    query.flip(true);
    expect(root.dataset.colorScheme).toBe('dark');
  });

  it('control: a light device starts light, and stopping removes the listener', () => {
    const root = document.createElement('html');
    const query = fakeQuery(false);
    const stop = followSystemColorScheme(root, query);
    expect(root.dataset.colorScheme).toBe('light');
    expect(query.listeners).toBe(1);
    stop();
    expect(query.listeners).toBe(0);
    query.flip(true);
    expect(root.dataset.colorScheme).toBe('light');
  });
});
