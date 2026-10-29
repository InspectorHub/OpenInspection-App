import type { EditorScreen } from './EditorScreen';

/** How the editor's chunk is loaded. A seam so a test can make the load fail and then succeed. */
export const editorModule: { load(): Promise<{ EditorScreen: typeof EditorScreen }> } = {
  load: () => import('./EditorScreen'),
};
