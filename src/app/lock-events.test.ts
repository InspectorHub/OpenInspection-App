import { describe, expect, it } from 'vitest';
import { createUnlockEmitter } from './lock-events';

describe('createUnlockEmitter', () => {
  it('emits only on a change from locked to unlocked', () => {
    const emitter = createUnlockEmitter();
    let calls = 0;
    emitter.onUnlocked(() => {
      calls += 1;
    });
    emitter.note({ locked: false });
    emitter.note({ locked: true, reason: 'expired' });
    emitter.note({ locked: true, reason: 'clock' });
    expect(calls).toBe(0);
    emitter.note({ locked: false });
    expect(calls).toBe(1);
    emitter.note({ locked: false });
    expect(calls).toBe(1);
    emitter.note({ locked: true, reason: 'revoked' });
    emitter.note({ locked: false });
    expect(calls).toBe(2);
  });

  it('a first observation of "unlocked" is not a transition', () => {
    const emitter = createUnlockEmitter();
    let calls = 0;
    emitter.onUnlocked(() => {
      calls += 1;
    });
    emitter.note({ locked: false });
    expect(calls).toBe(0);
  });

  it('unsubscribes, and a failing listener does not stop the others', () => {
    const emitter = createUnlockEmitter();
    const seen: string[] = [];
    emitter.onUnlocked(() => {
      throw new Error('boom');
    });
    const off = emitter.onUnlocked(() => seen.push('second'));
    expect(emitter.listeners()).toBe(2);
    emitter.note({ locked: true, reason: 'expired' });
    emitter.note({ locked: false });
    expect(seen).toEqual(['second']);
    off();
    expect(emitter.listeners()).toBe(1);
    emitter.note({ locked: true, reason: 'expired' });
    emitter.note({ locked: false });
    expect(seen).toEqual(['second']);
  });
});
