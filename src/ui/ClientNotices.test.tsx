// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../app/compose';
import { createSignedInWorld, type World } from '../app/test-support/world';
import type { CompatInfo } from '../auth/server-config';
import { touchMaxSeen } from '../offline/lock-state';
import { ClientNotices } from './ClientNotices';
import { ServerTooOld } from './ServerTooOld';
import { TestflightExpiry } from './TestflightExpiry';
import { UpdateRecommended } from './UpdateRecommended';
import { UpgradeRequired } from './UpgradeRequired';
import { useUpdateLink } from './update-link';

afterEach(cleanup);

const DAY = 86_400_000;
const BUILT = '2026-10-01T12:00:00.000Z';
const BUILT_MS = Date.parse(BUILT);
const APK = 'https://downloads.example.test/app.apk';

/** Lets every already-resolved promise run, inside act. Microtasks only: no timer, no clock. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 200; i += 1) await Promise.resolve();
  });
}

function compat(over: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...over };
}

describe('UpgradeRequired', () => {
  it('is an alert with a real heading, and says editing is off but saved work stays and uploads', () => {
    render(<UpgradeRequired platform="android" downloadUrl={APK} openExternal={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Update required' })).toBeInTheDocument();
    expect(screen.getByText(/editing is turned off/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps uploading/i)).toBeInTheDocument();
  });

  it('Android: nothing opens until the person taps, then the normalised https address opens once', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    render(<UpgradeRequired platform="android" downloadUrl="https://Downloads.example.test/app.apk" openExternal={openExternal} />);
    expect(openExternal).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Download update' });
    expect(button.className).toContain('min-h-11');
    await userEvent.setup().click(button);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://downloads.example.test/app.apk');
  });

  it('two taps in one frame open it once', async () => {
    const openExternal = vi.fn(() => new Promise<void>(() => undefined));
    render(<UpgradeRequired platform="android" downloadUrl={APK} openExternal={openExternal} />);
    const button = screen.getByRole('button', { name: 'Download update' });
    await act(async () => {
      button.click();
      button.click();
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it.each([['http://downloads.example.test/app.apk'], ['javascript:alert(1)'], ['file:///sdcard/app.apk'], ['intent://x#Intent;end'], ['not a url'], [null]])(
    'a download address that is not https (%s) gives no button and is never opened',
    (url) => {
      const openExternal = vi.fn();
      render(<UpgradeRequired platform="android" downloadUrl={url} openExternal={openExternal} />);
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByText(/ask your administrator/i)).toBeInTheDocument();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('Windows: no TestFlight wording; the button is Download update (control: iOS keeps TestFlight)', () => {
    const { container } = render(<UpgradeRequired platform="windows" downloadUrl={APK} openExternal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Download update' })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/testflight/i);
    render(<UpgradeRequired platform="windows" downloadUrl={null} openExternal={vi.fn()} />);
    expect(screen.getAllByText(/ask your administrator/i).length).toBeGreaterThan(0);
    const ios = render(<UpgradeRequired platform="ios" downloadUrl={null} openExternal={vi.fn()} />);
    expect(ios.container).toHaveTextContent(/testflight/i);
  });

  it('iOS: the button is named for TestFlight and opens the address the server gave', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    render(<UpgradeRequired platform="ios" downloadUrl="https://testflight.apple.com/join/abc123" openExternal={openExternal} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open TestFlight' }));
    expect(openExternal).toHaveBeenCalledWith('https://testflight.apple.com/join/abc123');
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull();
  });

  it('iOS without an address points at the TestFlight app and offers no button', () => {
    render(<UpgradeRequired platform="ios" downloadUrl={null} openExternal={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/open the testflight app/i)).toBeInTheDocument();
  });

  it('a link that cannot be opened is said so in an alert, and the button works again', async () => {
    const openExternal = vi.fn(() => Promise.reject(new Error('no browser')));
    render(<UpgradeRequired platform="android" downloadUrl={APK} openExternal={openExternal} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole('button', { name: 'Download update' }));
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('an opener that throws at once is handled the same way', async () => {
    const openExternal = vi.fn(() => {
      throw new Error('plugin missing');
    });
    render(<UpgradeRequired platform="android" downloadUrl={APK} openExternal={openExternal} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
  });
});

describe('useUpdateLink', () => {
  it('open() with no usable address does nothing, whatever calls it', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    for (const url of [null, 'http://downloads.example.test/app.apk', 'javascript:alert(1)']) {
      const { result } = renderHook(() => useUpdateLink(url, openExternal));
      expect(result.current.href).toBeNull();
      await act(async () => {
        result.current.open();
      });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('a failure is cleared as soon as the next attempt starts, not only when it ends', async () => {
    let attempt = 0;
    const openExternal = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('no browser')) : new Promise<void>(() => undefined);
    });
    render(<UpgradeRequired platform="android" downloadUrl={APK} openExternal={openExternal} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Download update' }));
    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download update' }));
    await waitFor(() => expect(screen.queryByText(/could not be opened/i)).toBeNull());
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

describe('ServerTooOld', () => {
  it('is a polite status with a heading, tells the person to contact the administrator and that work stays on the device', () => {
    render(<ServerTooOld />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Server version too old' })).toBeInTheDocument();
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
    expect(screen.getByText(/will not sync/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TestflightExpiry', () => {
  it('says when the test build expires and what to do', () => {
    render(<TestflightExpiry notice={{ expiresAt: Date.UTC(2027, 0, 3, 12), expired: false }} locale="en-US" />);
    expect(screen.getByRole('status')).toHaveTextContent('Test build expires on January 3, 2027. Connect to the internet to update.');
  });

  it('after the expiry it says the build has expired', () => {
    render(<TestflightExpiry notice={{ expiresAt: Date.UTC(2027, 0, 3, 12), expired: true }} locale="en-US" />);
    expect(screen.getByRole('status')).toHaveTextContent('Test build expired on January 3, 2027. Connect to the internet to update.');
  });
});

describe('UpdateRecommended', () => {
  it('offers the update and a dismiss button with its own accessible name', async () => {
    const onDismiss = vi.fn();
    const openExternal = vi.fn(() => Promise.resolve());
    render(<UpdateRecommended platform="android" downloadUrl={APK} openExternal={openExternal} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent(/newer version of the app is available/i);
    const user = userEvent.setup();
    const dismiss = screen.getByRole('button', { name: 'Dismiss update notice' });
    expect(dismiss.className).toContain('min-h-11');
    await user.click(screen.getByRole('button', { name: 'Update' }));
    expect(openExternal).toHaveBeenCalledWith(APK);
    expect(onDismiss).not.toHaveBeenCalled();
    await user.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Windows: the button is Download update and TestFlight is never named (control: iOS)', () => {
    const windows = render(<UpdateRecommended platform="windows" downloadUrl={APK} openExternal={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Download update' })).toBeInTheDocument();
    expect(windows.container).not.toHaveTextContent(/testflight/i);
    windows.unmount();
    render(<UpdateRecommended platform="ios" downloadUrl={APK} openExternal={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open TestFlight' })).toBeInTheDocument();
  });

  it('without a usable address only Dismiss is offered', () => {
    render(<UpdateRecommended platform="android" downloadUrl="http://downloads.example.test/app.apk" openExternal={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss update notice' })).toBeInTheDocument();
  });
});

async function view(world: World, over: Partial<AppServices> = {}, origin = world.server.origin) {
  const services: AppServices = { ...world.services, ...over };
  const rendered = render(<ClientNotices services={services} origin={origin} locale="en-US" />);
  return { services, ...rendered };
}

describe('ClientNotices: the states reach the screen', () => {
  it('shows nothing when nothing is asked of the person (control for every case below)', async () => {
    const world = await createSignedInWorld();
    const { container } = await view(world);
    expect(container).toBeEmptyDOMElement();
  });

  it('upgrade required shows the update screen and not the others', async () => {
    const world = await createSignedInWorld();
    const { services } = await view(world);
    act(() => services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0', downloadUrl: APK })));
    expect(await screen.findByRole('heading', { name: 'Update required' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Server version too old' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss update notice' })).toBeNull();
  });

  it('the update button hands the address to the app opener, never before a tap', async () => {
    const world = await createSignedInWorld();
    const openExternal = vi.fn(() => Promise.resolve());
    const { services } = await view(world, { openExternal });
    act(() => services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0', downloadUrl: APK })));
    const button = await screen.findByRole('button', { name: 'Download update' });
    expect(openExternal).not.toHaveBeenCalled();
    await userEvent.setup().click(button);
    expect(openExternal).toHaveBeenCalledWith(APK);
  });

  it('a 426 seen before any compat answer shows the update screen without a button', async () => {
    const world = await createSignedInWorld();
    const { services } = await view(world);
    act(() => services.clientState.noteUpgrade(world.server.origin, 'required'));
    expect(await screen.findByRole('heading', { name: 'Update required' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull();
  });

  it('a server on an older contract shows the server screen, and the update screen stays away', async () => {
    const world = await createSignedInWorld();
    const { services } = await view(world);
    act(() => services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true, serverContractVersion: 0 })));
    expect(await screen.findByRole('heading', { name: 'Server version too old' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Update required' })).toBeNull();
  });

  it('facts about another server show nothing here', async () => {
    const world = await createSignedInWorld();
    const { services, container } = await view(world);
    act(() => services.clientState.applyCompat('https://elsewhere.example.test', compat({ minSupported: '9.0.0', serverTooOld: true })));
    expect(container).toBeEmptyDOMElement();
  });

  it('a recommended update of another server shows no banner here (control: the same facts for this server do)', async () => {
    const world = await createSignedInWorld();
    const { services, container } = await view(world);
    act(() => services.clientState.applyCompat('https://elsewhere.example.test', compat({ recommended: '9.0.0' })));
    await settle();
    expect(container).toBeEmptyDOMElement();
    act(() => services.clientState.applyCompat(world.server.origin, compat({ recommended: '9.0.0' })));
    expect(await screen.findByRole('button', { name: 'Dismiss update notice' })).toBeInTheDocument();
  });

  it('the recommended banner shows, and Dismiss removes it for good', async () => {
    const world = await createSignedInWorld();
    const { services } = await view(world);
    act(() => services.clientState.applyCompat(world.server.origin, compat({ recommended: '9.0.0' })));
    const dismiss = await screen.findByRole('button', { name: 'Dismiss update notice' });
    await userEvent.setup().click(dismiss);
    expect(screen.queryByRole('button', { name: 'Dismiss update notice' })).toBeNull();
    await act(async () => {
      await services.clientState.settled();
      services.clientState.applyCompat(world.server.origin, compat({ recommended: '9.0.0' }));
      await services.clientState.settled();
    });
    expect(screen.queryByRole('button', { name: 'Dismiss update notice' })).toBeNull();
  });
});

describe('ClientNotices: a server without the check for removed inspections', () => {
  const SENTENCE = 'This server does not support removing deleted inspections.';

  it('says so once, low-key, and Dismiss removes it for good (control: a server that has the check says nothing)', async () => {
    const world = await createSignedInWorld();
    const { services, container } = await view(world);
    act(() => services.clientState.applyCompat(world.server.origin, compat({ serverContractVersion: 2 })));
    await settle();
    expect(container).toBeEmptyDOMElement();
    act(() => services.clientState.applyCompat(world.server.origin, compat({ serverContractVersion: 1 })));
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    const dismiss = screen.getByRole('button', { name: 'Dismiss server notice' });
    expect(dismiss.className).toContain('min-h-11');
    await userEvent.setup().click(dismiss);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    await act(async () => {
      await services.clientState.settled();
      services.clientState.applyCompat(world.server.origin, compat({ serverContractVersion: 1 }));
      await services.clientState.settled();
    });
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it('the notice of another server is not shown here', async () => {
    const world = await createSignedInWorld();
    const { services, container } = await view(world);
    act(() => services.clientState.applyCompat('https://elsewhere.example.test', compat({ serverContractVersion: 1 })));
    await settle();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ClientNotices: the test-build expiry', () => {
  async function ios(world: World, now: number) {
    world.clock.set(now);
    return view(world, { platform: 'ios', builtAt: BUILT });
  }

  it('76 days after the build the warning shows, with the date formatted for the person', async () => {
    const world = await createSignedInWorld();
    await ios(world, BUILT_MS + 76 * DAY);
    expect(await screen.findByRole('status')).toHaveTextContent('Test build expires on December 30, 2026. Connect to the internet to update.');
  });

  it('75 days after the build it does not show (control beside the case above)', async () => {
    const world = await createSignedInWorld();
    const { container } = await ios(world, BUILT_MS + 75 * DAY);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('on Android the same dates never warn', async () => {
    const world = await createSignedInWorld();
    world.clock.set(BUILT_MS + 80 * DAY);
    const { container } = await view(world, { platform: 'android', builtAt: BUILT });
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('a device clock set back does not hide the warning: the latest time ever seen counts', async () => {
    const world = await createSignedInWorld();
    await touchMaxSeen(world.db, BUILT_MS + 80 * DAY);
    await ios(world, BUILT_MS + 10 * DAY);
    expect(await screen.findByRole('status')).toHaveTextContent(/Test build expires on/);
  });

  it('re-reads the clock after every compat attempt, not on a timer', async () => {
    const world = await createSignedInWorld();
    const { services, container } = await ios(world, BUILT_MS + 10 * DAY);
    await settle();
    expect(container).toBeEmptyDOMElement();
    world.clock.set(BUILT_MS + 77 * DAY);
    act(() => services.clientState.noteCompatAttempt(world.server.origin));
    expect(await screen.findByRole('status')).toHaveTextContent(/Test build expires on/);
  });

  it('without a build date there is no warning and no error', async () => {
    const world = await createSignedInWorld();
    world.clock.set(BUILT_MS + 80 * DAY);
    const { container } = await view(world, { platform: 'ios', builtAt: null });
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('the expiry notice sits beside the others without replacing them', async () => {
    const world = await createSignedInWorld();
    const { services } = await ios(world, BUILT_MS + 80 * DAY);
    act(() => services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true })));
    const region = await screen.findByRole('heading', { name: 'Server version too old' });
    expect(region).toBeInTheDocument();
    expect(within(document.body).getAllByRole('status').length).toBe(2);
  });
});
