import { describe, expect, it } from 'vitest';
import type { Network } from '../platform/network';
import { openNetworkFlag } from './network-flag';

interface FakeNetwork extends Network {
  emit(online: boolean): void;
  listeners(): number;
  resolveRead(online: boolean): void;
  failRead(): void;
}

function fakeNetwork(preRead?: boolean): FakeNetwork {
  const listeners = new Set<(online: boolean) => void>();
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
        listeners.delete(cb);
      };
    },
    emit: (online) => {
      for (const cb of [...listeners]) cb(online);
    },
    listeners: () => listeners.size,
    resolveRead: resolve,
    failRead: () => {
      reject(new Error('plugin down'));
    },
  };
}

describe('network flag', () => {
  it('is synchronous and starts from the pre-read state', async () => {
    const flag = await openNetworkFlag(fakeNetwork(true));
    expect(flag.isOnline()).toBe(true);
    const offline = await openNetworkFlag(fakeNetwork(false));
    expect(offline.isOnline()).toBe(false);
  });

  it('follows changes and tells subscribers only about real changes', async () => {
    const net = fakeNetwork(true);
    const flag = await openNetworkFlag(net);
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
    const opening = openNetworkFlag(net);
    net.emit(false);
    net.resolveRead(true);
    const flag = await opening;
    expect(flag.isOnline()).toBe(false);
  });

  it('a read that fails counts as offline, not as online', async () => {
    const net = fakeNetwork();
    const opening = openNetworkFlag(net);
    net.failRead();
    const flag = await opening;
    expect(flag.isOnline()).toBe(false);
  });

  it('unsubscribe stops one subscriber; dispose leaves no listener on the platform', async () => {
    const net = fakeNetwork(true);
    const flag = await openNetworkFlag(net);
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
    net.emit(true);
    expect(kept).toEqual([false]);
    expect(flag.isOnline()).toBe(false);
  });

  it('a subscriber that throws does not stop the others', async () => {
    const net = fakeNetwork(true);
    const flag = await openNetworkFlag(net);
    const seen: boolean[] = [];
    flag.onOnlineChange(() => {
      throw new Error('boom');
    });
    flag.onOnlineChange((online) => seen.push(online));
    net.emit(false);
    expect(seen).toEqual([false]);
  });
});
