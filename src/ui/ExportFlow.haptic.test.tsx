// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExportWorld } from '../export/test-support/world';
import { setHapticsPort } from '../platform/haptics';
import { ready, threeWithOneQuarantined, view } from './test-support/export-view';

afterEach(() => {
  cleanup();
  setHapticsPort(null);
});

describe('export and haptics', () => {
  it('a finished export vibrates once as a success', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    await ready();
    expect(notify).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('success');
  });

  it('an export that has nothing to send does not vibrate (control: only a finished one does)', async () => {
    const notify = vi.fn(() => Promise.resolve());
    setHapticsPort({ notify });
    const world = await createExportWorld();
    view(world);
    await ready();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Nothing to export' });
    expect(notify).not.toHaveBeenCalled();
  });
});
