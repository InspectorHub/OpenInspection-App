import type { CollabConnector, ResultsDocHandle } from '@inspectorhub/field-ui';
import type { EditorRegistry } from './editor-registry';

/**
 * Wraps the stack's connector so the editor registry sees every document handle. The handle handed to the editor
 * forwards each property live (the real handle replaces its document on a version restore), and its `destroy`
 * unregisters it before the real one runs. A refused connection throws out of `connect` and registers nothing.
 */
export function wrapCollab(inner: CollabConnector, registry: Pick<EditorRegistry, 'setHandle' | 'clearHandle'>): CollabConnector {
  return {
    connect: (inspectionId, opts) => {
      const real = inner.connect(inspectionId, opts);
      let destroyed = false;
      const handle: ResultsDocHandle = {
        get doc() {
          return real.doc;
        },
        get persistenceSynced() {
          return real.persistenceSynced;
        },
        synced: () => real.synced(),
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          registry.clearHandle(inspectionId, handle);
          real.destroy();
        },
      };
      registry.setHandle(inspectionId, handle);
      return handle;
    },
    purge: (inspectionId) => inner.purge(inspectionId),
  };
}
