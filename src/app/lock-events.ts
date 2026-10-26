import type { LockOutcome } from '../offline/lock-state';

/**
 * Turns the lock evaluations the app already makes (the foreground monitor and the lock screen) into one event: the
 * device went from locked to unlocked. The flows that stopped for the lock resume through it.
 */
export interface UnlockEmitter {
  /** Feed every evaluation here, in order. Only a change from locked to unlocked emits. */
  note(outcome: LockOutcome): void;
  /** For the `onUnlocked` dependency of a flow; returns the unsubscribe function. */
  onUnlocked(listener: () => void): () => void;
  /** Listeners currently subscribed (tests and teardown checks). */
  listeners(): number;
}

export function createUnlockEmitter(): UnlockEmitter {
  const listeners = new Set<() => void>();
  let locked: boolean | null = null;
  return {
    note: (outcome) => {
      const wasLocked = locked === true;
      locked = outcome.locked;
      if (!wasLocked || outcome.locked) return;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A failing listener must not stop the others.
        }
      }
    },
    onUnlocked: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listeners: () => listeners.size,
  };
}
