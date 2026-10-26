import { describe, expect, it } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import type { Network } from '../platform/network';
import { openNetworkFlag } from './network-flag';

interface FakeNetwork extends Network {
  emit(online: boolean): void;
  listeners(): number;
  unsubscribes(): number;
  resolveRead(online: boolean): void;
  failRead(): void;
}

/** `keepsListening`: a platform whose unsubscribe does nothing, to prove the flag ignores events after dispose by itself. */
function fakeNetwork(preRead?: boolean, keepsListening = false): FakeNetwork {
  const listeners = new Set<(online: boolean) => void>();
  let unsubscribes = 0;
  let resolve: (online: boolean) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const read = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (preRead !== undefined) resolve(preRead);
  return {
    online: () => read,
    onChange: (cb) => {
      listeners.add(cb);
      return () => {
        unsubscribes += 1;
        if (!keepsListening) listeners.delete(cb);
      };
    },
    emit: (online) => {
      for (const cb of [...listeners]) cb(online);
    },
    listeners: () => listeners.size,
    unsubscribes: () => unsubscribes,
    resolveRead: resolve,
    failRead: () => {
      reject(new Error('plugin down'));
    },
  };
}

const open = (network: Network) => openNetworkFlag(network, { timers: createManualTimers() });

describe('network flag', () => {
  it('is returned at once, so a cleanup that runs before the read finished can still dispose it', () => {
    const net = fakeNetwork();
    const flag = open(net);
    expect(flag.isOnline()).toBe(false);
    expect(net.listeners()).toBe(1);
    flag.dispose();
    expect(net.listeners()).toBe(0);
  });

  it('ready settles with the pre-read state, which isOnline then reports', async () => {
    const online = open(fakeNetwork(true));
    await online.ready;
    expect(online.isOnline()).toBe(true);
    const offline = open(fakeNetwork(false));
    await offline.ready;
    expect(offline.isOnline()).toBe(false);
  });

  it('follows changes and tells subscribers only about real changes', async () => {
    const net = fakeNetwork(true);
    const flag = open(net);
    await flag.ready;
    const seen: boolean[] = [];
    flag.onOnlineChange((online) => seen.push(online));
    net.emit(true);
    net.emit(false);
    net.emit(false);
    net.emit(true);
    expect(seen).toEqual([false, true]);
    expect(flag.isOnline()).toBe(true);
  });

  it('a change that arrives while the first read is pending wins over the read', async () => {
    const net = fakeNetwork();
    const flag = open(net);
    net.emit(false);
    net.resolveRead(true);
    await flag.ready;
    expect(flag.isOnline()).toBe(false);
  });

  it('a read that fails counts as offline, not as online', async () => {
    const net = fakeNetwork();
    const flag = open(net);
    net.failRead();
    await flag.ready;
    expect(flag.isOnline()).toBe(false);
  });

  it('a read that never answers is given up after the bound and counts as offline; control: an answer in time is used', async () => {
    const timers = createManualTimers();
    const slow = openNetworkFlag(fakeNetwork(), { timers, timeoutMs: 3000 });
    expect(timers.delays()).toEqual([3000]);
    timers.fireWithDelay(3000);
    await slow.ready;
    expect(slow.isOnline()).toBe(false);

    const timers2 = createManualTimers();
    const quick = openNetworkFlag(fakeNetwork(true), { timers: timers2, timeoutMs: 3000 });
    await quick.ready;
    expect(quick.isOnline()).toBe(true);
    expect(timers2.pending()).toBe(0);
  });

  it('a read that finishes after the bound does not undo a change that came in the meantime', async () => {
    const timers = createManualTimers();
    const net = fakeNetwork();
    const flag = openNetworkFlag(net, { timers, timeoutMs: 3000 });
    timers.fireWithDelay(3000);
    await flag.ready;
    net.emit(true);
    net.resolveRead(false);
    await Promise.resolve();
    expect(flag.isOnline()).toBe(true);
  });

  it('unsubscribe stops one subscriber; dispose leaves no listener on the platform', async () => {
    const net = fakeNetwork(true);
    const flag = open(net);
    await flag.ready;
    const kept: boolean[] = [];
    const dropped: boolean[] = [];
    flag.onOnlineChange((online) => kept.push(online));
    const stop = flag.onOnlineChange((online) => dropped.push(online));
    stop();
    net.emit(false);
    expect(kept).toEqual([false]);
    expect(dropped).toEqual([]);
    expect(net.listeners()).toBe(1);
    flag.dispose();
    expect(net.listeners()).toBe(0);
  });

  it('dispose is idempotent: the platform listener is removed once', () => {
    const net = fakeNetwork(true);
    const flag = open(net);
    flag.dispose();
    flag.dispose();
    expect(net.unsubscribes()).toBe(1);
  });

  it('after dispose an event the platform still delivers changes nothing and reaches nobody', async () => {
    const net = fakeNetwork(true, true);
    const flag = open(net);
    await flag.ready;
    const seen: boolean[] = [];
    flag.onOnlineChange((online) => seen.push(online));
    net.emit(false);
    expect(seen).toEqual([false]);
    flag.dispose();
    net.emit(true);
    expect(seen).toEqual([false]);
    expect(flag.isOnline()).toBe(false);
  });

  it('a subscriber that throws does not stop the others', async () => {
    const net = fakeNetwork(true);
    const flag = open(net);
    await flag.ready;
    const seen: boolean[] = [];
    flag.onOnlineChange(() => {
      throw new Error('boom');
    });
    flag.onOnlineChange((online) => seen.push(online));
    net.emit(false);
    expect(seen).toEqual([false]);
  });
});
