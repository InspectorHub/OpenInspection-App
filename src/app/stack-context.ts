import { createContext, useContext } from 'react';
import type { OfflineStack } from './offline-stack';

/** The live offline stack of the signed-in screen, or null where there is none (every other screen, or a build without one). */
export const OfflineStackContext = createContext<OfflineStack | null>(null);

export function useOfflineStack(): OfflineStack | null {
  return useContext(OfflineStackContext);
}
