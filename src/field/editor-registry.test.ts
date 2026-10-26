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
    const release = registry.register('insp-1');
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    expect(registry.isOpenInEditor('insp-2')).toBe(false);
    release();
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
  });

  it('survives a double mount: two registrations need two releases', () => {
    const registry = createEditorRegistry();
    const first = registry.register('insp-1');
    const second = registry.register('insp-1');
    first();
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    second();
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
  });

  it('a release called more than once cannot clear another component registration', () => {
    const registry = createEditorRegistry();
    const first = registry.register('insp-1');
    const second = registry.register('insp-1');
    first();
    first();
    first();
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    second();
    second();
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
  });

  it('a late release does not close a newer registration of the same inspection', () => {
    const registry = createEditorRegistry();
    const old = registry.register('insp-1');
    old();
    const fresh = registry.register('insp-1');
    old();
    expect(registry.isOpenInEditor('insp-1')).toBe(true);
    fresh();
    expect(registry.isOpenInEditor('insp-1')).toBe(false);
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
