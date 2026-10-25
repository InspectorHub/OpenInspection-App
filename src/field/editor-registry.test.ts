import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createEditorRegistry, editorRegistry } from './editor-registry';
import type { ResultsDocHandle } from '@inspectorhub/field-ui';

function handleWith(doc: Y.Doc): ResultsDocHandle & { replace(next: Y.Doc): void } {
  let current = doc;
  return {
    get doc() {
      return current;
    },
    persistenceSynced: Promise.resolve(),
    synced: () => true,
    destroy: () => undefined,
    replace: (next) => {
      current = next;
    },
  };
}

describe('editor registry', () => {
  it('counts an inspection as open from register, before any connection exists', () => {
    const registry = createEditorRegistry();
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
    registry.register('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    expect(registry.isOpenInEditor('insp-2')).toBe(false);
    registry.unregister('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
  });

  it('survives a double mount: two registers need two unregisters', () => {
    const registry = createEditorRegistry();
    registry.register('insp-1');
    registry.register('insp-1');
    registry.unregister('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    registry.unregister('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
  });

  it('an unregister without a register does not go negative', () => {
    const registry = createEditorRegistry();
    registry.unregister('insp-1');
    registry.register('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
  });

  it('liveDoc reads the handle live: a replaced document is seen at once', () => {
    const registry = createEditorRegistry();
    const first = new Y.Doc();
    const second = new Y.Doc();
    const handle = handleWith(first);
    expect(registry.liveDoc('insp-1')).toBeNull();
    registry.setHandle('insp-1', handle);
    expect(registry.liveDoc('insp-1')).toBe(first);
    handle.replace(second);
    expect(registry.liveDoc('insp-1')).toBe(second);
    expect(registry.getHandle('insp-1')).toBe(handle);
  });

  it('clearHandle removes only the handle it is given', () => {
    const registry = createEditorRegistry();
    const older = handleWith(new Y.Doc());
    const newer = handleWith(new Y.Doc());
    registry.setHandle('insp-1', older);
    registry.setHandle('insp-1', newer);
    registry.clearHandle('insp-1', older);
    expect(registry.getHandle('insp-1')).toBe(newer);
    registry.clearHandle('insp-1', newer);
    expect(registry.getHandle('insp-1')).toBeNull();
    expect(registry.liveDoc('insp-1')).toBeNull();
  });

  it('exports one module-level instance shaped like the stack editor port', () => {
    expect(typeof editorRegistry.isOpenInEditor).toBe('function');
    expect(typeof editorRegistry.liveDoc).toBe('function');
  });
});
