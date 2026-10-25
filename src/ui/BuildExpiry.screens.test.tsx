// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../app/compose';
import { createSignedInWorld, type World } from '../app/test-support/world';
import { Locked } from './Locked';
import { ServerSetup } from './ServerSetup';
import { SignIn } from './SignIn';

afterEach(cleanup);

const DAY = 86_400_000;
const BUILT = '2026-10-01T12:00:00.000Z';
const BUILT_MS = Date.parse(BUILT);
const WARNING = /Test build expires on .*Connect to the internet to update\./;

function services(world: World, platform: 'ios' | 'android', age: number): AppServices {
  world.clock.set(BUILT_MS + age * DAY);
  return { ...world.services, platform, builtAt: BUILT };
}

type Screen = 'locked' | 'sign-in' | 'server-setup';

function show(kind: Screen, world: World, s: AppServices): void {
  const origin = world.server.origin;
  if (kind === 'locked') render(<Locked services={s} origin={origin} reason="expired" onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={vi.fn()} />);
  else if (kind === 'sign-in') render(<SignIn services={s} origin={origin} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
  else render(<ServerSetup services={s} onConnected={vi.fn()} devHttpSwitch={false} initialUrl="" />);
}

describe.each<Screen>(['locked', 'sign-in', 'server-setup'])('the test-build expiry notice on the %s screen', (kind) => {
  it('an iOS build 80 days old shows it, after the first-level heading', async () => {
    const world = await createSignedInWorld();
    show(kind, world, services(world, 'ios', 80));
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    const first = screen.getAllByRole('heading')[0];
    expect(first?.tagName).toBe('H1');
  });

  it('control: 75 days old, or Android at any age, shows nothing', async () => {
    const young = await createSignedInWorld();
    show(kind, young, services(young, 'ios', 75));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(WARNING)).toBeNull();
    cleanup();
    const android = await createSignedInWorld();
    show(kind, android, services(android, 'android', 200));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
