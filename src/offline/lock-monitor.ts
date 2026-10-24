import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { evaluateAndPersist, type LockOutcome } from './lock-state';

/** How often the lock is re-evaluated while the app is in the foreground. */
export const LOCK_CHECK_INTERVAL_MS = 60_000;

/** Foreground/background transitions of the app. `onChange` returns an unsubscribe function. */
export interface AppStatePort {
  onChange(listener: (active: boolean) => void): () => void;
}

export interface Scheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Arrow wrappers, not the bare builtins: a WebView throws `Illegal invocation` when they run with another `this`. */
export const realScheduler: Scheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** The part of `@capacitor/app` the port uses. */
export interface AppStateSource {
  addListener(name: 'appStateChange', callback: (event: { isActive: boolean }) => void): Promise<{ remove(): Promise<void> }>;
}

/**
 * Thin wiring over the plugin. A refused registration leaves a port that never fires; the 60 second
 * interval still covers the foreground, so a missing resume event costs at most one minute.
 */
export function createCapacitorAppState(app: AppStateSource): AppStatePort {
  return {
    onChange: (listener) => {
      let active = true;
      let registration: Promise<{ remove(): Promise<void> }> | null = null;
      try {
        registration = app.addListener('appStateChange', (event) => {
          if (active) listener(event.isActive);
        });
      } catch {
        registration = null;
      }
      registration?.catch(() => undefined);
      return () => {
        active = false;
        registration?.then((handle) => handle.remove()).catch(() => undefined);
      };
    },
  };
}

export interface LockMonitorDeps {
  db: Db;
  clock: Clock;
  scheduler: Scheduler;
  /** Omitted where there is no resume signal; the interval still runs. */
  appState?: AppStatePort;
  onOutcome(outcome: LockOutcome): void;
  /** An evaluation that threw. Neither locks nor unlocks: the last known screen stays. */
  onError?(err: unknown): void;
}

export interface LockMonitor {
  /** Evaluates now, after any evaluation already running. Settles once that evaluation has been reported. */
  checkNow(): Promise<void>;
  /** Settles when every evaluation requested so far has finished. */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * Re-evaluates the lock on every resume and every 60 seconds while foregrounded; the boot-time
 * evaluation is the caller's. Evaluations run one after another, so two triggers in the same moment
 * report in order and a slow one cannot overwrite a newer answer. Every evaluation persists the
 * latest time seen (see `evaluateAndPersist`). After `stop()` nothing more is reported.
 */
export function startLockMonitor(deps: LockMonitorDeps): LockMonitor {
  let stopped = false;
  let handle: unknown = null;
  let queue: Promise<void> = Promise.resolve();

  function checkNow(): Promise<void> {
    const run = async (): Promise<void> => {
      if (stopped) return;
      try {
        const outcome = await evaluateAndPersist(deps.db, deps.clock.now());
        if (!stopped) deps.onOutcome(outcome);
      } catch (err) {
        if (!stopped) deps.onError?.(err);
      }
    };
    queue = queue.then(run);
    return queue;
  }

  function startInterval(): void {
    if (handle !== null || stopped) return;
    handle = deps.scheduler.setInterval(() => {
      void checkNow();
    }, LOCK_CHECK_INTERVAL_MS);
  }

  function stopInterval(): void {
    if (handle === null) return;
    deps.scheduler.clearInterval(handle);
    handle = null;
  }

  startInterval();
  const unsubscribe = deps.appState?.onChange((active) => {
    if (stopped) return;
    if (active) {
      startInterval();
      void checkNow();
    } else {
      stopInterval();
    }
  });

  return {
    checkNow,
    idle: () => queue,
    stop: () => {
      stopped = true;
      stopInterval();
      unsubscribe?.();
    },
  };
}
