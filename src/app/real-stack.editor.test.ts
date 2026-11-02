import { describe, expect, it, vi } from 'vitest';
import type { SocketFactory } from '../collab/connector';
import { editorRegistry } from '../field/editor-registry';
import type { Network } from '../platform/network';
import type { UploaderPluginLike } from '../platform/uploader';
import type { OfflineStackDeps } from './offline-stack';
import { createStackFactory } from './real-stack';
import { createWorld } from './test-support/world';

const built = vi.hoisted(() => ({ deps: null as OfflineStackDeps | null }));

vi.mock('./offline-stack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./offline-stack')>();
  return {
    ...actual,
    createOfflineStack: (deps: OfflineStackDeps) => {
      built.deps = deps;
      return actual.createOfflineStack(deps);
    },
  };
});

describe('the real stack factory', () => {
  it('gives the stack the editor registry, so a purge sees an inspection that is open and the photo step finds its live document', async () => {
    const world = await createWorld();
    const appState = { onChange: () => () => undefined };
    const network: Network = { online: () => Promise.resolve(false), onChange: () => () => undefined };
    const uploaderPlugin: UploaderPluginLike = {
      startUpload: () => Promise.resolve({ id: 'fake-upload' }),
      removeUpload: () => Promise.resolve(),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
      acknowledgeEvent: () => Promise.resolve(),
    };
    const socketFactory: SocketFactory = () => ({ isOpen: () => false, send: () => undefined, close: () => undefined });
    const stack = createStackFactory({ network, uploaderPlugin, socketFactory }, { appState })({ services: world.services, origin: world.server.origin, identity: { userId: 'u', tenantId: 't', role: 'inspector' }, allowInsecureHttp: true, onUnlocked: () => () => undefined });
    try {
      expect(built.deps?.editor).toBe(editorRegistry);
      expect(built.deps?.network).toBe(network);
      expect(built.deps?.uploaderPlugin).toBe(uploaderPlugin);
      expect(built.deps?.openSocket).toBe(socketFactory);
    } finally {
      await stack.stop();
    }
  });
});
