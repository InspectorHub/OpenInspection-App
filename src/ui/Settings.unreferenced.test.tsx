// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import { createSignedInWorld } from '../app/test-support/world';
import type { MediaRow } from '../media/store';
import { open, stackWith } from './test-support/settings-world';

afterEach(cleanup);

const uploaded: MediaRow = { pendingId: 'p1', inspectionId: 'i1', kind: 'photo', path: 'media/p1.jpg', contentType: 'image/jpeg', meta: '{}', state: 'uploaded', attempts: 0, uploadedKey: 'k/p1', createdAt: 1 };

function stackWithStranded(): OfflineStack {
  const base = stackWith();
  const mediaReconciler = { idle: () => Promise.resolve(), recheckMissing: vi.fn(), countUnreferenced: () => 1, removeUnreferenced: () => Promise.resolve({ removed: 1, attached: 0, skipped: 0 }) };
  const store = { listRows: () => Promise.resolve([uploaded]) };
  return { ...base, mediaReconciler, store } as unknown as OfflineStack;
}

describe('Settings: photos that reached the server but were never attached', () => {
  it('shows the section, with a removal, when a stack holds such a photo', async () => {
    const world = await createSignedInWorld();
    await open(world, { stack: stackWithStranded() });
    const section = await screen.findByRole('region', { name: 'Photos not attached' });
    expect(section).toHaveTextContent('1 photo or clip on this device is on the server but not attached to an inspection yet.');
    expect(screen.getByRole('button', { name: 'Remove from this device, 1 photo or clip' })).toBeInTheDocument();
  });

  it('control: with no such photo, and with no session at all, the section is not there', async () => {
    const world = await createSignedInWorld();
    await open(world, { stack: stackWith() });
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('region', { name: 'Photos not attached' })).toBeNull();
    cleanup();
    await open(world, { stack: null });
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('region', { name: 'Photos not attached' })).toBeNull();
  });
});
