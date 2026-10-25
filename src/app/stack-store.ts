/** A value that changes over time and tells its listeners; shaped for React's `useSyncExternalStore`. */
export interface ReadableStore<T> {
  get(): T;
  /** Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface WritableStore<T> extends ReadableStore<T> {
  /** Merges `patch` into the value. Listeners run only when a field actually changed. */
  patch(patch: Partial<T>): void;
}

export function createStore<T extends object>(initial: T): WritableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch: (patch) => {
      const keys = Object.keys(patch) as (keyof T)[];
      if (keys.every((key) => Object.is(value[key], patch[key]))) return;
      value = { ...value, ...patch };
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A failing listener must not stop the others or the code that changed the value.
        }
      }
    },
  };
}
