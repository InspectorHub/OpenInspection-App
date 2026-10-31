import { Preferences } from '@capacitor/preferences';
import type { KeyValue } from './kv';

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
