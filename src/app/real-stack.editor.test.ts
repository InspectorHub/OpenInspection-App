import { describe, expect, it, vi } from 'vitest';
import { editorRegistry } from '../field/editor-registry';
import type { OfflineStackDeps } from './offline-stack';
import { createRealStackFactory } from './real-stack';
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
    createRealStackFactory({ appState })({ services: world.services, origin: world.server.origin, identity: { userId: 'u', tenantId: 't', role: 'inspector' }, allowInsecureHttp: true, onUnlocked: () => () => undefined });
    expect(built.deps?.editor).toBe(editorRegistry);
  });
});
