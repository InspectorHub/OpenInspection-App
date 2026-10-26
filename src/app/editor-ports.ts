import { clientPolicy } from './client-state';
import type { AppServices } from './compose';
import type { OfflineStack } from './offline-stack';

/** What the editor's data source and its api client are given, from the one place the state is kept. */
export interface EditorPorts {
  /** For `LocalDataSourceDeps.canEdit`: false while a required update turns editing off. */
  canEdit(): boolean;
  /** For `createApiClient`: the lock (`gate`) and the server's contract (`serverTooOld`) kept apart, so each has its own problem. */
  api: {
    gate(): Promise<boolean>;
    serverTooOld(): boolean;
  };
}

export function editorPorts(services: Pick<AppServices, 'clientState'>, stack: Pick<OfflineStack, 'locked' | 'serverTooOld'>, origin: string): EditorPorts {
  return {
    canEdit: () => clientPolicy(services.clientState.store.get(), origin).canEdit,
    api: {
      gate: async () => !(await stack.locked()),
      serverTooOld: () => stack.serverTooOld(),
    },
  };
}
