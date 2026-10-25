import { describe, expect, it } from 'vitest';
import { createStore } from './stack-store';

describe('createStore', () => {
  it('merges patches, notifies on change only, and unsubscribes', () => {
    const store = createStore({ a: false, b: 0 });
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.patch({ a: false });
    expect(calls).toBe(0);
    store.patch({ a: true });
    expect(store.get()).toEqual({ a: true, b: 0 });
    expect(calls).toBe(1);
    off();
    store.patch({ b: 2 });
    expect(calls).toBe(1);
    expect(store.get()).toEqual({ a: true, b: 2 });
  });

  it('hands out a new object for a change (so React sees it) and keeps the old one for none', () => {
    const store = createStore({ a: false });
    const first = store.get();
    store.patch({ a: false });
    expect(store.get()).toBe(first);
    store.patch({ a: true });
    expect(store.get()).not.toBe(first);
  });

  it('a failing listener does not stop the others', () => {
    const store = createStore({ a: false });
    let reached = false;
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(() => {
      reached = true;
    });
    store.patch({ a: true });
    expect(reached).toBe(true);
  });
});
