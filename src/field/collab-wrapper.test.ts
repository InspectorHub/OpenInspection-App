import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { ResultsDocHandle } from '@inspectorhub/field-ui';
import { wrapCollab } from './collab-wrapper';
import { createEditorRegistry } from './editor-registry';

interface InnerHandle extends ResultsDocHandle {
  swap(next: Y.Doc): void;
  destroyed(): number;
}

function innerHandle(): InnerHandle {
  let doc = new Y.Doc();
  let destroyed = 0;
  return {
    get doc() {
      return doc;
    },
    persistenceSynced: Promise.resolve(),
    synced: () => true,
    destroy: () => {
      destroyed += 1;
    },
    swap: (next) => {
      doc = next;
    },
    destroyed: () => destroyed,
  };
}

function setup() {
  const registry = createEditorRegistry();
  const handles: InnerHandle[] = [];
  const purged: string[] = [];
  let failNext = false;
  const inner = {
    connect: () => {
      if (failNext) {
        failNext = false;
        throw new Error('blocked');
      }
      const handle = innerHandle();
      handles.push(handle);
      return handle;
    },
    purge: (id: string) => {
      purged.push(id);
      return Promise.resolve();
    },
  };
  return { registry, handles, purged, wrapped: wrapCollab(inner, registry), failNext: () => (failNext = true) };
}

describe('collab wrapper', () => {
  it('registers the handle the connector returns and exposes its live document', () => {
    const { registry, handles, wrapped } = setup();
    const handle = wrapped.connect('insp-1', {});
    expect(registry.liveDoc('insp-1')).toBe(handles[0]?.doc);
    handles[0]?.swap(new Y.Doc());
    expect(registry.liveDoc('insp-1')).toBe(handles[0]?.doc);
    expect(handle.doc).toBe(handles[0]?.doc);
  });

  it('control: before connect there is no document', () => {
    const { registry } = setup();
    expect(registry.liveDoc('insp-1')).toBeNull();
  });

  it('destroy clears the registration and reaches the real handle once', () => {
    const { registry, handles, wrapped } = setup();
    const handle = wrapped.connect('insp-1', {});
    handle.destroy();
    expect(registry.getHandle('insp-1')).toBeNull();
    expect(handles[0]?.destroyed()).toBe(1);
  });

  it('a late destroy of an old handle does not drop the newer registration', () => {
    const { registry, wrapped } = setup();
    const old = wrapped.connect('insp-1', {});
    const fresh = wrapped.connect('insp-1', {});
    old.destroy();
    expect(registry.getHandle('insp-1')).not.toBeNull();
    expect(registry.liveDoc('insp-1')).toBe(fresh.doc);
  });

  it('a refused connection registers nothing and the error reaches the caller', () => {
    const { registry, wrapped, failNext } = setup();
    failNext();
    expect(() => wrapped.connect('insp-1', {})).toThrow('blocked');
    expect(registry.getHandle('insp-1')).toBeNull();
  });

  it('purge passes straight through', async () => {
    const { purged, wrapped } = setup();
    await wrapped.purge('insp-1');
    expect(purged).toEqual(['insp-1']);
  });

  it('forwards the sync flags of the real handle', async () => {
    const { wrapped } = setup();
    const handle = wrapped.connect('insp-1', {});
    expect(handle.synced()).toBe(true);
    await expect(handle.persistenceSynced).resolves.toBeUndefined();
  });
});
