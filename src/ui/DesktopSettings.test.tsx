// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSettingsPort } from '../desktop/updater-port';
import { DesktopSettings } from './DesktopSettings';

afterEach(cleanup);

const port = (updater: DesktopSettingsPort['updater']): DesktopSettingsPort => ({
  appVersion: '0.1.1', updater,
  checkForUpdates: vi.fn(), openLogs: vi.fn(), openDataFolder: vi.fn(),
});

describe('DesktopSettings', () => {
  it('shows the app version, update state, and desktop folder actions', async () => {
    const desktop = port({ kind: 'idle' });
    render(<DesktopSettings desktop={desktop} />);
    expect(screen.getByText('0.1.1')).toBeInTheDocument();
    expect(screen.getByText('Updates are on')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    await user.click(screen.getByRole('button', { name: 'Open log folder' }));
    await user.click(screen.getByRole('button', { name: 'Open data folder' }));
    expect(desktop.checkForUpdates).toHaveBeenCalledOnce();
    expect(desktop.openLogs).toHaveBeenCalledOnce();
    expect(desktop.openDataFolder).toHaveBeenCalledOnce();
    expect(screen.getByText('Uploads continue only while InspectorHub is open.')).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'disabled', reason: 'unsigned' }, 'Updates are turned off in this build'],
    [{ kind: 'disabled', reason: 'dev' }, 'Updates are turned off in this build'],
    [{ kind: 'checking' }, 'Checking for updates'],
    [{ kind: 'available', version: '0.2.0' }, 'Version 0.2.0 is available'],
    [{ kind: 'downloading', percent: 43 }, 'Downloading update: 43%'],
    [{ kind: 'ready', version: '0.2.0' }, 'Version 0.2.0 is ready to install'],
    [{ kind: 'error', code: 'network' }, 'Could not check for updates'],
    [{ kind: 'error', code: 'verify' }, 'Could not check for updates'],
    [{ kind: 'error', code: 'other' }, 'Could not check for updates'],
  ] as const)('describes updater state %j', (updater, copy) => {
    render(<DesktopSettings desktop={port(updater)} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    if (updater.kind === 'disabled') expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  });
});
