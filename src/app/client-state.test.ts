import { describe, expect, it } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { createMemoryKeyValue, type KeyValue } from '../platform/kv';
import { clientPolicy, createClientState, serverTooOldFor, type ClientStateController } from './client-state';

const ORIGIN = 'https://oi.example.test';
const OTHER = 'https://other.example.test';

function compat(over: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...over };
}

function make(kv: KeyValue = createMemoryKeyValue(), appVersion = '1.0.0'): ClientStateController {
  return createClientState({ kv, appVersion });
}

describe('upgrade signals from responses', () => {
  it('"required" puts the server into the required state, and records which server said so', () => {
    const state = make();
    expect(state.store.get().upgrade).toBe('none');
    state.noteUpgrade(ORIGIN, 'required');
    expect(state.store.get()).toMatchObject({ origin: ORIGIN, upgrade: 'required' });
  });

  it('"recommended" shows the banner; any other value changes nothing (control beside both)', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'banana');
    state.noteUpgrade(ORIGIN, '');
    state.noteUpgrade(ORIGIN, 'REQUIRED');
    await state.settled();
    expect(state.store.get()).toMatchObject({ origin: null, upgrade: 'none', bannerVisible: false });
    state.noteUpgrade(ORIGIN, 'recommended');
    await state.settled();
    expect(state.store.get()).toMatchObject({ origin: ORIGIN, upgrade: 'recommended', bannerVisible: true });
  });

  it('a later "recommended" never lowers "required"', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'required');
    state.noteUpgrade(ORIGIN, 'recommended');
    await state.settled();
    expect(state.store.get()).toMatchObject({ upgrade: 'required', bannerVisible: false });
  });

  it('the compat answer is authoritative: it can clear a signal, and set one the headers have not shown', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'required');
    state.applyCompat(ORIGIN, compat());
    expect(state.store.get().upgrade).toBe('none');
    state.applyCompat(ORIGIN, compat({ minSupported: '1.1.0' }));
    expect(state.store.get().upgrade).toBe('required');
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(state.store.get()).toMatchObject({ upgrade: 'recommended', recommendedVersion: '1.1.0', bannerVisible: true });
  });

  it('keeps the download address the compat answer carried', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ minSupported: '1.1.0', downloadUrl: 'https://downloads.example.test/app.apk' }));
    expect(state.store.get().downloadUrl).toBe('https://downloads.example.test/app.apk');
  });

  it('a signal from another server starts that server from a clean state, never mixing the two', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ minSupported: '1.1.0', serverTooOld: true, downloadUrl: 'https://downloads.example.test/app.apk' }));
    state.noteUpgrade(OTHER, 'recommended');
    expect(state.store.get()).toMatchObject({ origin: OTHER, serverTooOld: false, downloadUrl: null });
  });
});

describe('the recommended banner shows once per app version', () => {
  it('after Dismiss it stays hidden, also after a restart with the same version', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv);
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    expect(first.store.get().bannerVisible).toBe(true);
    first.dismissBanner();
    expect(first.store.get().bannerVisible).toBe(false);
    await first.settled();

    const restarted = make(kv);
    restarted.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await restarted.settled();
    expect(restarted.store.get().bannerVisible).toBe(false);
  });

  it('control: a different app version that is still behind shows it again', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv, '1.0.0');
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    first.dismissBanner();
    await first.settled();
    const updated = make(kv, '1.0.1');
    updated.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await updated.settled();
    expect(updated.store.get().bannerVisible).toBe(true);
  });

  it('control: a newer recommended version shows it again for the same app version', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv);
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    first.dismissBanner();
    await first.settled();
    first.applyCompat(ORIGIN, compat({ recommended: '1.2.0' }));
    await first.settled();
    expect(first.store.get().bannerVisible).toBe(true);
  });

  it('dismissal is per server: another server still shows it', async () => {
    const kv = createMemoryKeyValue();
    const state = make(kv);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    state.dismissBanner();
    await state.settled();
    state.applyCompat(OTHER, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(state.store.get().bannerVisible).toBe(true);
  });

  it('the banner is not shown when the signal is not "recommended"', async () => {
    const state = make();
    state.applyCompat(ORIGIN, compat());
    await state.settled();
    expect(state.store.get().bannerVisible).toBe(false);
    state.noteUpgrade(ORIGIN, 'required');
    await state.settled();
    expect(state.store.get().bannerVisible).toBe(false);
  });

  it('storage that cannot be read shows a dismissible banner; storage that cannot be written does not throw', async () => {
    const broken: KeyValue = { get: () => Promise.reject(new Error('no storage')), set: () => Promise.reject(new Error('no storage')) };
    const state = make(broken);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(state.store.get().bannerVisible).toBe(true);
    expect(() => state.dismissBanner()).not.toThrow();
    await state.settled();
    expect(state.store.get().bannerVisible).toBe(false);
  });

  it('a read that comes back after the signal went away does not bring the banner back', async () => {
    let release: (value: string | null) => void = () => undefined;
    const slow: KeyValue = { get: () => new Promise((resolve) => (release = resolve)), set: () => Promise.resolve() };
    const state = make(slow);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    state.applyCompat(ORIGIN, compat());
    release(null);
    await state.settled();
    expect(state.store.get()).toMatchObject({ upgrade: 'none', bannerVisible: false });
  });
});

describe('the server contract', () => {
  it('a server on an older contract is recorded, a sufficient one is not (control)', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ serverTooOld: true, serverContractVersion: 0 }));
    expect(state.store.get().serverTooOld).toBe(true);
    state.applyCompat(ORIGIN, compat());
    expect(state.store.get().serverTooOld).toBe(false);
  });

  it('a compat request that failed changes no fact: a known-old server stays old, an unknown one stays unknown', () => {
    const state = make();
    state.noteCompatAttempt(ORIGIN);
    expect(state.store.get()).toMatchObject({ serverTooOld: false, upgrade: 'none' });
    state.applyCompat(ORIGIN, compat({ serverTooOld: true, minSupported: '1.1.0' }));
    state.noteCompatAttempt(ORIGIN);
    expect(state.store.get()).toMatchObject({ serverTooOld: true, upgrade: 'required' });
  });

  it('every attempt, answered or not, moves the refresh counter the interface re-reads on', () => {
    const state = make();
    const before = state.store.get().refreshes;
    state.noteCompatAttempt(ORIGIN);
    state.applyCompat(ORIGIN, compat());
    expect(state.store.get().refreshes).toBe(before + 2);
  });

  it('serverTooOldFor follows the state of that server only', () => {
    const state = make();
    const mine = serverTooOldFor(state, ORIGIN);
    const seen: boolean[] = [];
    mine.subscribe(() => seen.push(mine.get()));
    expect(mine.get()).toBe(false);
    state.applyCompat(ORIGIN, compat({ serverTooOld: true }));
    expect(mine.get()).toBe(true);
    state.applyCompat(ORIGIN, compat());
    expect(mine.get()).toBe(false);
    expect(seen).toEqual([true, false]);
    const theirs = serverTooOldFor(state, OTHER);
    state.applyCompat(ORIGIN, compat({ serverTooOld: true }));
    expect(theirs.get()).toBe(false);
  });
});

describe('clientPolicy: what each state allows', () => {
  function state(over: { upgrade?: 'none' | 'recommended' | 'required'; tooOld?: boolean }): ClientStateController {
    const s = make();
    s.applyCompat(ORIGIN, compat({ serverTooOld: over.tooOld ?? false, ...(over.upgrade === 'required' ? { minSupported: '9.0.0' } : {}), ...(over.upgrade === 'recommended' ? { recommended: '9.0.0' } : {}) }));
    return s;
  }

  it('normal: everything is allowed', () => {
    expect(clientPolicy(state({}).store.get(), ORIGIN)).toEqual({ canEdit: true, canSync: true, canExport: true });
  });

  it('upgrade required: no editing, but sync and export stay on (Review Focus 4)', () => {
    expect(clientPolicy(state({ upgrade: 'required' }).store.get(), ORIGIN)).toEqual({ canEdit: false, canSync: true, canExport: true });
  });

  it('server too old: no sync, but editing and export stay on (Review Focus 5)', () => {
    expect(clientPolicy(state({ tooOld: true }).store.get(), ORIGIN)).toEqual({ canEdit: true, canSync: false, canExport: true });
  });

  it('both at once: only export is certain', () => {
    expect(clientPolicy(state({ upgrade: 'required', tooOld: true }).store.get(), ORIGIN)).toEqual({ canEdit: false, canSync: false, canExport: true });
  });

  it('a recommended update restricts nothing', () => {
    expect(clientPolicy(state({ upgrade: 'recommended' }).store.get(), ORIGIN)).toEqual({ canEdit: true, canSync: true, canExport: true });
  });

  it('facts about another server restrict nothing here', () => {
    expect(clientPolicy(state({ upgrade: 'required', tooOld: true }).store.get(), OTHER)).toEqual({ canEdit: true, canSync: true, canExport: true });
  });
});
