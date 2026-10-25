import { useSyncExternalStore } from 'react';
import type { ClientState, ClientStateController } from './client-state';

/** The client state as React state: re-renders when a field changes. */
export function useClientState(controller: ClientStateController): ClientState {
  return useSyncExternalStore(controller.store.subscribe, controller.store.get);
}
