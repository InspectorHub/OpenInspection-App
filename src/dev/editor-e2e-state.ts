import type { FieldDataSource } from '@inspectorhub/field-ui';
import { editorObserver, type EditorProbe } from '../ui/editor-observer';

declare global {
  interface Window {
    __oiE2EEditorState?: {
      isOnline(): boolean;
      hasLiveDoc(): boolean;
      readOnly: boolean;
      onlineReads: Array<{ online: boolean; stack: string }>;
      storePuts: Array<{ contentType: string; size: number; online: boolean; outcome: 'stored' | 'rejected'; code?: string }>;
      notifications: Array<{ message: string; variant: string; online: boolean; hasLiveDoc: boolean; stack: string }>;
      codeReads: Array<{ code: unknown; name: string; message: string; stack: string }>;
    };
  }
}

type EditorE2EState = NonNullable<Window['__oiE2EEditorState']>;

/**
 * Publishes what the Electron end-to-end specs read about the open editor on `window.__oiE2EEditorState`: the link state
 * the editor consulted, the media it stored or refused (with every read of the refusal's `code`), and what it said. It
 * wraps the editor's data source from outside, so the editor screen carries no test hook. Only the development
 * renderer entry installs it.
 */
export function installEditorE2EState(): void {
  editorObserver.install((probe: EditorProbe) => {
    const state: EditorE2EState = { ...probe, onlineReads: [], storePuts: [], notifications: [], codeReads: [] };
    window.__oiE2EEditorState = state;
    return {
      notified(message, variant) {
        state.notifications.push({ message, variant, online: probe.isOnline(), hasLiveDoc: probe.hasLiveDoc(), stack: new Error().stack ?? '' });
      },
      attach(source: FieldDataSource) {
        const isOnline = source.isOnline.bind(source);
        source.isOnline = () => {
          const online = isOnline();
          if (state.onlineReads.length === 40) state.onlineReads.shift();
          state.onlineReads.push({ online, stack: new Error().stack ?? '' });
          return online;
        };
        const store = source.media.store;
        const put = store.put.bind(store);
        store.put = async (record) => {
          const details = { contentType: record.blob.type, size: record.blob.size, online: probe.isOnline() };
          try {
            await put(record);
            state.storePuts.push({ ...details, outcome: 'stored' });
          } catch (error) {
            let code: string | undefined;
            try {
              const descriptor = Object.getOwnPropertyDescriptor(error as object, 'code');
              if (descriptor?.configurable && 'value' in descriptor) {
                const originalCode = descriptor.value;
                Object.defineProperty(error, 'code', {
                  configurable: true,
                  enumerable: descriptor.enumerable,
                  get: () => {
                    state.codeReads.push({ code: originalCode, name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : '', stack: new Error().stack ?? '' });
                    return originalCode;
                  },
                });
              }
              const candidate = Reflect.get(error as object, 'code');
              if (typeof candidate === 'string') code = candidate;
            } catch {
              // Diagnostic data is best effort; preserve the original error.
            }
            state.storePuts.push({ ...details, outcome: 'rejected', ...(code === undefined ? {} : { code }) });
            throw error;
          }
        };
      },
      dispose() {
        if (window.__oiE2EEditorState === state) delete window.__oiE2EEditorState;
      },
    };
  });
}
