import type { Doc } from 'yjs';
import type { ResultsDocHandle } from '@inspectorhub/field-ui';

/**
 * What the offline stack asks about the editor: is an inspection open, and what is its live document. An inspection
 * counts as open from the moment the screen registers it, which is before the collaboration connector has connected,
 * so there is no window in which a purge sees "nothing open" while the editor is mounting. The document is read from
 * the handle on every call: a version restore replaces it.
 */
export interface EditorRegistry {
  isOpenInEditor(inspectionId: string): boolean;
  liveDoc(inspectionId: string): Doc | null;
  /**
   * Counts the inspection as open until the returned function is called. Each call of the function releases only the
   * registration it came from, and a second call does nothing, so a cleanup that runs twice cannot close the
   * registration of another mount.
   */
  register(inspectionId: string): () => void;
  setHandle(inspectionId: string, handle: ResultsDocHandle): void;
  /** Removes the handle only if it is still the registered one, so a late destroy cannot drop a newer connection. */
  clearHandle(inspectionId: string, handle: ResultsDocHandle): void;
  getHandle(inspectionId: string): ResultsDocHandle | null;
}

export function createEditorRegistry(): EditorRegistry {
  const open = new Map<string, number>();
  const handles = new Map<string, ResultsDocHandle>();
  return {
    register: (id) => {
      open.set(id, (open.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (open.get(id) ?? 0) - 1;
        if (count > 0) open.set(id, count);
        else open.delete(id);
      };
    },
    isOpenInEditor: (id) => (open.get(id) ?? 0) > 0,
    setHandle: (id, handle) => {
      handles.set(id, handle);
    },
    clearHandle: (id, handle) => {
      if (handles.get(id) === handle) handles.delete(id);
    },
    getHandle: (id) => handles.get(id) ?? null,
    liveDoc: (id): Doc | null => handles.get(id)?.doc ?? null,
  };
}

/** The one registry of the app. Passed to `createOfflineStack` as its `editor` port and used by the editor screen. */
export const editorRegistry: EditorRegistry = createEditorRegistry();
