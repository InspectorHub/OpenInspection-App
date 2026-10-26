import { Preferences } from '@capacitor/preferences';

/** A minimal string key-value store (non-secret app state). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The subset of the Preferences plugin the adapter uses. */
export interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

export function keyValueFromPreferences(prefs: PreferencesLike): KeyValue {
  return {
    get: async (key) => (await prefs.get({ key })).value,
    set: (key, value) => prefs.set({ key, value }),
  };
}

/** Thin real-plugin wiring. */
export function createPreferencesKeyValue(): KeyValue {
  return keyValueFromPreferences(Preferences);
}

/** An in-memory `KeyValue` for tests. */
export function createMemoryKeyValue(initial: Record<string, string> = {}): KeyValue & { entries(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    entries: () => Object.fromEntries(map),
  };
}
