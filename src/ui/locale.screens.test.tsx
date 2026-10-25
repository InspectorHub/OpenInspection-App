// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld } from '../app/test-support/world';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { recordVerified } from '../offline/lock-state';
import { stubDeviceLocale } from '../test-support/default-locale';
import { Settings } from './Settings';
import { WorkList } from './WorkList';
import { at, createListWorld, NOW, seedPkg } from './test-support/worklist-world';

beforeEach(() => {
  stubDeviceLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Characters of the scripts a Chinese, Japanese or Korean device writes; spelt as ranges so this public file stays English-only. */
const FOREIGN = new RegExp(`[${String.fromCodePoint(0x3000)}-${String.fromCodePoint(0x9fff)}${String.fromCodePoint(0xac00)}-${String.fromCodePoint(0xd7af)}]`);

describe('on a phone set to Chinese the screens still read English (no locale handed in)', () => {
  it('control: the device really is Chinese here', () => {
    expect(FOREIGN.test(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'minute'))).toBe(true);
  });

  it('the work list: the scheduled time and every other line are English', async () => {
    const w = await createListWorld();
    await seedPkg(w.db, { id: 'a', scheduledAt: at(-3, 21) });
    render(<WorkList stack={w.stack} now={() => NOW} pollMs={0} />);
    await screen.findByTestId('row-a');
    expect(document.body.textContent ?? '').not.toMatch(FOREIGN);
    expect(screen.getByTestId('row-a')).toHaveTextContent(/\d{1,2}:\d{2} (AM|PM)/);
  });

  it('Settings: the last verification and the build date are English', async () => {
    const world = await createSignedInWorld();
    await recordVerified(world.db, Date.UTC(2026, 9, 20, 12, 0, 0), 21);
    world.clock.set(Date.UTC(2026, 9, 22, 12, 0, 0));
    const services = { ...world.services, builtAt: '2026-10-20T08:30:00.000Z', appVersion: '1.4.2', openExternal: vi.fn(() => Promise.resolve()) };
    render(<Settings services={services} origin={world.server.origin} stack={null} onBack={vi.fn()} onExport={vi.fn()} onSignedOut={vi.fn()} onCleared={vi.fn()} timers={createManualTimers()} />);
    await waitFor(() => expect(screen.getByTestId('settings-last-verified')).toHaveTextContent('October 20, 2026'));
    expect(screen.getByTestId('settings-last-verified')).toHaveTextContent('Checked 2 days ago');
    expect(screen.getByTestId('built-on')).toHaveTextContent('October 20, 2026');
    expect(document.body.textContent ?? '').not.toMatch(FOREIGN);
  });
});
