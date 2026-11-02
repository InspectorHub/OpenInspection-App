import type { FieldDataSource } from '@inspectorhub/field-ui';

/** What an observer may ask of the editor it watches. */
export interface EditorProbe {
  isOnline(): boolean;
  hasLiveDoc(): boolean;
  readOnly: boolean;
}

/** What the editor screen tells an observer about one open editor. */
export interface EditorObservation {
  /** The editor said something to the person. */
  notified(message: string, variant: string): void;
  /** The data source the editor is about to load from; the observer may wrap its methods. */
  attach(source: FieldDataSource): void;
  /** The editor closed. */
  dispose(): void;
}

export type EditorObserver = (probe: EditorProbe) => EditorObservation;

let installed: EditorObserver | null = null;

/** The seam a development build uses to watch editors from outside the screen. Release code never installs one. */
export const editorObserver = {
  install(observer: EditorObserver | null): void { installed = observer; },
  current(): EditorObserver | null { return installed; },
};
