import { describe, expect, it } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { createMemoryKeyValue, type KeyValue } from '../platform/kv';
import { clientPolicy, createClientState, factsFor, serverTooOldFor, type ClientStateController, type OriginFacts } from './client-state';

const ORIGIN = 'https://oi.example.test';
const OTHER = 'https://other.example.test';

function compat(over: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...over };
}

function make(kv: KeyValue = createMemoryKeyValue(), appVersion = '1.0.0'): ClientStateController {
  return createClientState({ kv, appVersion });
}

const facts = (state: ClientStateController, origin = ORIGIN): OriginFacts => factsFor(state.store.get(), origin);

describe('upgrade signals from responses', () => {
  it('"required" puts the server into the required state, and only that server', () => {
    const state = make();
    expect(facts(state).upgrade).toBe('none');
    state.noteUpgrade(ORIGIN, 'required');
    expect(facts(state).upgrade).toBe('required');
    expect(facts(state, OTHER).upgrade).toBe('none');
  });

  it('"recommended" shows the banner; any other value changes nothing (control beside both)', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'banana');
    state.noteUpgrade(ORIGIN, '');
    state.noteUpgrade(ORIGIN, 'REQUIRED');
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'none', bannerVisible: false });
    expect(state.store.get().origins.size).toBe(0);
    state.noteUpgrade(ORIGIN, 'recommended');
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'recommended', bannerVisible: true });
  });

  it('a later "recommended" never lowers "required"', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'required');
    state.noteUpgrade(ORIGIN, 'recommended');
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'required', bannerVisible: false });
  });

  it('"required" ends a banner read that is still in flight: the banner does not come back', async () => {
    let release: (value: string | null) => void = () => undefined;
    const slow: KeyValue = { get: () => new Promise((resolve) => (release = resolve)), set: () => Promise.resolve() };
    const state = make(slow);
    state.noteUpgrade(ORIGIN, 'recommended');
    state.noteUpgrade(ORIGIN, 'required');
    release(null);
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'required', bannerVisible: false });
  });

  it('the compat answer is authoritative: it can clear a signal, and set one the headers have not shown', async () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'required');
    state.applyCompat(ORIGIN, compat());
    expect(facts(state).upgrade).toBe('none');
    state.applyCompat(ORIGIN, compat({ minSupported: '1.1.0' }));
    expect(facts(state).upgrade).toBe('required');
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'recommended', recommendedVersion: '1.1.0', bannerVisible: true, compatKnown: true });
  });

  it('keeps the download address the compat answer carried', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ minSupported: '1.1.0', downloadUrl: 'https://downloads.example.test/app.apk' }));
    expect(facts(state).downloadUrl).toBe('https://downloads.example.test/app.apk');
  });
});

describe('facts are kept per server', () => {
  it('a late answer from one server never erases the facts of another (the probe: B too old, then A fine)', () => {
    const state = make();
    state.applyCompat(OTHER, compat({ serverTooOld: true, serverContractVersion: 0, minSupported: '9.0.0', downloadUrl: 'https://downloads.example.test/app.apk' }));
    state.applyCompat(ORIGIN, compat());
    expect(facts(state, OTHER)).toMatchObject({ serverTooOld: true, upgrade: 'required', downloadUrl: 'https://downloads.example.test/app.apk' });
    expect(facts(state, ORIGIN)).toMatchObject({ serverTooOld: false, upgrade: 'none' });
    expect(serverTooOldFor(state, OTHER).get()).toBe(true);
    expect(serverTooOldFor(state, ORIGIN).get()).toBe(false);
  });

  it('a header from one server does not touch the other', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ serverTooOld: true }));
    state.noteUpgrade(OTHER, 'required');
    expect(facts(state, ORIGIN)).toMatchObject({ serverTooOld: true, upgrade: 'none' });
    expect(facts(state, OTHER).upgrade).toBe('required');
  });

  it('signing in to the same server again keeps nothing stale once a fresh answer arrives', () => {
    const state = make();
    state.noteUpgrade(ORIGIN, 'required');
    state.applyCompat(ORIGIN, compat({ serverTooOld: true, minSupported: '9.0.0' }));
    state.applyCompat(ORIGIN, compat());
    expect(facts(state, ORIGIN)).toMatchObject({ upgrade: 'none', serverTooOld: false });
  });

  it('a server nothing is known about reads as current, not as too old', () => {
    const state = make();
    expect(facts(state, 'https://never-seen.example.test')).toMatchObject({ upgrade: 'none', serverTooOld: false, compatKnown: false, reconcileSupported: null });
  });
});

describe('the recommended banner shows once per app version', () => {
  it('after Dismiss it stays hidden, also after a restart with the same version', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv);
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    expect(facts(first).bannerVisible).toBe(true);
    first.dismissBanner(ORIGIN);
    expect(facts(first).bannerVisible).toBe(false);
    await first.settled();

    const restarted = make(kv);
    restarted.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await restarted.settled();
    expect(facts(restarted).bannerVisible).toBe(false);
  });

  it('control: a different app version that is still behind shows it again', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv, '1.0.0');
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    first.dismissBanner(ORIGIN);
    await first.settled();
    const updated = make(kv, '1.0.1');
    updated.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await updated.settled();
    expect(facts(updated).bannerVisible).toBe(true);
  });

  it('control: a newer recommended version shows it again for the same app version; an older or equal one does not', async () => {
    const kv = createMemoryKeyValue();
    const first = make(kv);
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    first.dismissBanner(ORIGIN);
    await first.settled();
    first.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await first.settled();
    expect(facts(first).bannerVisible).toBe(false);
    first.applyCompat(ORIGIN, compat({ recommended: '1.2.0' }));
    await first.settled();
    expect(facts(first).bannerVisible).toBe(true);
  });

  it('dismissed on the bare header, it does not pop again when compat later names the version for the same app version', async () => {
    const kv = createMemoryKeyValue();
    const state = make(kv);
    state.noteUpgrade(ORIGIN, 'recommended');
    await state.settled();
    expect(facts(state).bannerVisible).toBe(true);
    state.dismissBanner(ORIGIN);
    await state.settled();
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(facts(state).bannerVisible).toBe(false);
  });

  it('control: dismissed against a named version, a bare header later does not bring it back either, but a new app version does', async () => {
    const kv = createMemoryKeyValue();
    const state = make(kv);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    state.dismissBanner(ORIGIN);
    await state.settled();
    const again = make(kv);
    again.noteUpgrade(ORIGIN, 'recommended');
    await again.settled();
    expect(facts(again).bannerVisible).toBe(false);
    const updated = make(kv, '1.0.1');
    updated.noteUpgrade(ORIGIN, 'recommended');
    await updated.settled();
    expect(facts(updated).bannerVisible).toBe(true);
  });

  it('dismissal is per server: another server still shows it', async () => {
    const kv = createMemoryKeyValue();
    const state = make(kv);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    state.dismissBanner(ORIGIN);
    await state.settled();
    state.applyCompat(OTHER, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(facts(state, OTHER).bannerVisible).toBe(true);
    expect(facts(state, ORIGIN).bannerVisible).toBe(false);
  });

  it('the banner is not shown when the signal is not "recommended"', async () => {
    const state = make();
    state.applyCompat(ORIGIN, compat());
    await state.settled();
    expect(facts(state).bannerVisible).toBe(false);
    state.noteUpgrade(ORIGIN, 'required');
    await state.settled();
    expect(facts(state).bannerVisible).toBe(false);
  });

  it('storage that cannot be read shows a dismissible banner; storage that cannot be written does not throw', async () => {
    const broken: KeyValue = { get: () => Promise.reject(new Error('no storage')), set: () => Promise.reject(new Error('no storage')) };
    const state = make(broken);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    await state.settled();
    expect(facts(state).bannerVisible).toBe(true);
    expect(() => state.dismissBanner(ORIGIN)).not.toThrow();
    await state.settled();
    expect(facts(state).bannerVisible).toBe(false);
  });

  it('a read that comes back after the signal went away does not bring the banner back', async () => {
    let release: (value: string | null) => void = () => undefined;
    const slow: KeyValue = { get: () => new Promise((resolve) => (release = resolve)), set: () => Promise.resolve() };
    const state = make(slow);
    state.applyCompat(ORIGIN, compat({ recommended: '1.1.0' }));
    state.applyCompat(ORIGIN, compat());
    release(null);
    await state.settled();
    expect(facts(state)).toMatchObject({ upgrade: 'none', bannerVisible: false });
  });
});

describe('the server contract', () => {
  it('a server on an older contract is recorded, a sufficient one is not (control)', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ serverTooOld: true, serverContractVersion: 0 }));
    expect(facts(state).serverTooOld).toBe(true);
    state.applyCompat(ORIGIN, compat());
    expect(facts(state).serverTooOld).toBe(false);
  });

  it('a compat request that failed changes no fact: a known-old server stays old, an unknown one stays unknown', () => {
    const state = make();
    state.noteCompatAttempt(ORIGIN);
    expect(facts(state)).toMatchObject({ serverTooOld: false, upgrade: 'none', compatKnown: false });
    state.applyCompat(ORIGIN, compat({ serverTooOld: true, minSupported: '1.1.0' }));
    state.noteCompatAttempt(ORIGIN);
    expect(facts(state)).toMatchObject({ serverTooOld: true, upgrade: 'required' });
  });

  it('every attempt, answered or not, moves the refresh counter the interface re-reads on', () => {
    const state = make();
    const before = state.store.get().refreshes;
    state.noteCompatAttempt(ORIGIN);
    state.applyCompat(ORIGIN, compat());
    expect(state.store.get().refreshes).toBe(before + 2);
  });

  it('serverTooOldFor follows the state of that server only, and stops telling a listener that left', () => {
    const state = make();
    const mine = serverTooOldFor(state, ORIGIN);
    const seen: boolean[] = [];
    const leave = mine.subscribe(() => seen.push(mine.get()));
    expect(mine.get()).toBe(false);
    state.applyCompat(ORIGIN, compat({ serverTooOld: true }));
    expect(mine.get()).toBe(true);
    state.applyCompat(ORIGIN, compat());
    expect(mine.get()).toBe(false);
    expect(seen).toEqual([true, false]);
    state.applyCompat(OTHER, compat({ serverTooOld: true }));
    expect(seen).toEqual([true, false]);
    leave();
    state.applyCompat(ORIGIN, compat({ serverTooOld: true }));
    expect(seen).toEqual([true, false]);
  });
});

describe('the check for removed inspections (a feature of contract 2)', () => {
  it('is supported from contract 2, unsupported below it, unknown before any answer', () => {
    const state = make();
    expect(facts(state).reconcileSupported).toBeNull();
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 1 }));
    expect(facts(state).reconcileSupported).toBe(false);
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 2 }));
    expect(facts(state).reconcileSupported).toBe(true);
  });

  it('an old server that is not "too old" is still synced with: only this feature is off', () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 1 }));
    expect(facts(state)).toMatchObject({ serverTooOld: false, reconcileSupported: false });
    expect(clientPolicy(state.store.get(), ORIGIN).canSync).toBe(true);
  });

  it('shows its notice once: not again after Dismiss, also after a restart; control: a sufficient server shows none', async () => {
    const kv = createMemoryKeyValue();
    const state = make(kv);
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 2 }));
    await state.settled();
    expect(facts(state).reconcileNoticeVisible).toBe(false);
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 1 }));
    await state.settled();
    expect(facts(state).reconcileNoticeVisible).toBe(true);
    state.dismissReconcileNotice(ORIGIN);
    await state.settled();
    expect(facts(state).reconcileNoticeVisible).toBe(false);
    const restarted = make(kv);
    restarted.applyCompat(ORIGIN, compat({ serverContractVersion: 1 }));
    await restarted.settled();
    expect(facts(restarted).reconcileNoticeVisible).toBe(false);
    const other = make(kv);
    other.applyCompat(OTHER, compat({ serverContractVersion: 1 }));
    await other.settled();
    expect(facts(other, OTHER).reconcileNoticeVisible).toBe(true);
  });

  it('a refusal as unsupported (no compat answer) turns the feature off for that server, once', async () => {
    const state = make();
    state.noteReconcileUnsupported(ORIGIN);
    await state.settled();
    expect(facts(state)).toMatchObject({ reconcileSupported: false, reconcileNoticeVisible: true });
    state.noteReconcileUnsupported(ORIGIN);
    expect(facts(state, OTHER).reconcileSupported).toBeNull();
  });

  it('the notice and the update banner decide independently: dismissing one leaves the other', async () => {
    const state = make();
    state.applyCompat(ORIGIN, compat({ serverContractVersion: 1, recommended: '1.1.0' }));
    await state.settled();
    expect(facts(state)).toMatchObject({ bannerVisible: true, reconcileNoticeVisible: true });
    state.dismissBanner(ORIGIN);
    await state.settled();
    expect(facts(state)).toMatchObject({ bannerVisible: false, reconcileNoticeVisible: true });
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
