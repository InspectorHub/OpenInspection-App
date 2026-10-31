import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { createPreferencesKeyValue } from './kv-capacitor';
import { initSecureStore, type SecureStore } from './secure-store';

/** Thin real-plugin wiring: device-only keychain access, iCloud sync off. */
export async function createRealSecureStore(): Promise<SecureStore> {
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  return initSecureStore(SecureStorage, createPreferencesKeyValue());
}
