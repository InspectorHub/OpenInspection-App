import { MIN_CONTRACT_FOR_RECONCILE, type CompatInfo } from '../auth/server-config';
import type { KeyValue } from '../platform/kv';
import { compareVersions, compatNotices } from './compat-notice';
import { createStore, type ReadableStore } from './stack-store';

/** What the server asks of this app version: nothing, an update when convenient, or an update before more editing. */
export type UpgradeLevel = 'none' | 'recommended' | 'required';

/**
 * What the app has learned about ONE server, for the interface, the editor gate and the sync flows. Unknown is allowed by design:
 * until a compat answer arrives (offline, a timeout, a page that is not the server's) the server counts as current, never as too
 * old, and nothing is blocked on a guess. A later answer, or the next foreground return, replaces the guess.
 */
export interface OriginFacts {
  upgrade: UpgradeLevel;
  /** The server speaks an older contract than this app needs. False when it is not known. */
  serverTooOld: boolean;
  /** Where to get the update, as the compat answer gave it (already https-only; still re-checked when it is opened). */
  downloadUrl: string | null;
  /** The newest version the server recommends, when the compat answer said. */
  recommendedVersion: string | null;
  /** Whether the server can answer the check for removed inspections: true or false once the contract is known, null before. */
  reconcileSupported: boolean | null;
  /** A compat answer was received in this run. */
  compatKnown: boolean;
  /** True while the "update available" banner should show. */
  bannerVisible: boolean;
  /** True while the "this server does not support removing deleted inspections" notice should show. */
  reconcileNoticeVisible: boolean;
}

/** Facts per server: a response only ever touches the facts of the server it came from. */
export interface ClientState {
  origins: ReadonlyMap<string, OriginFacts>;
  /** Counts compat attempts, answered or not; what the interface re-reads its time-based notices on. */
  refreshes: number;
}

const UNKNOWN: OriginFacts = {
  upgrade: 'none',
  serverTooOld: false,
  downloadUrl: null,
  recommendedVersion: null,
  reconcileSupported: null,
  compatKnown: false,
  bannerVisible: false,
  reconcileNoticeVisible: false,
};

/** The facts of one server; the "nothing known" facts when none arrived. */
export function factsFor(state: ClientState, origin: string): OriginFacts {
  return state.origins.get(origin) ?? UNKNOWN;
}

export interface ClientStateController {
  readonly store: ReadableStore<ClientState>;
  /** An `X-Client-Upgrade` value, or a 426, seen on a response from `origin`. Values other than `required` and `recommended` are ignored. */
  noteUpgrade(origin: string, value: string): void;
  /** A compat answer from `origin`. Authoritative for that server: it replaces every earlier signal from it, and touches no other server. */
  applyCompat(origin: string, compat: CompatInfo): void;
  /** A compat request that got no usable answer. Changes no fact. */
  noteCompatAttempt(origin: string): void;
  /** The check for removed inspections was refused as unsupported by `origin` (the server has no such route). */
  noteReconcileUnsupported(origin: string): void;
  /** The person closed the banner: not shown again for this app version and recommendation on this server. */
  dismissBanner(origin: string): void;
  /** The person closed the notice about the unsupported check on this server. */
  dismissReconcileNotice(origin: string): void;
  /** Settles when every banner decision started so far has finished. Never rejects. */
  settled(): Promise<void>;
}

export interface ClientStateDeps {
  kv: KeyValue;
  appVersion: string;
}

/** What each state allows. Sync and export are never tied to the version: captured work must always be deliverable. */
export interface ClientPolicy {
  canEdit: boolean;
  canSync: boolean;
  /** Always true. Exporting is the way out when everything else is refused, so no state may switch it off. */
  canExport: true;
}

/** The policy for the server at `origin`. Facts about another server restrict nothing. */
export function clientPolicy(state: ClientState, origin: string): ClientPolicy {
  const facts = factsFor(state, origin);
  return { canEdit: facts.upgrade !== 'required', canSync: !facts.serverTooOld, canExport: true };
}

/** One fact of one server as a store of its own (for the offline stack). */
function factStore<T>(controller: ClientStateController, origin: string, read: (facts: OriginFacts) => T): ReadableStore<T> {
  const get = (): T => read(factsFor(controller.store.get(), origin));
  return {
    get,
    subscribe: (listener) => {
      let last = get();
      return controller.store.subscribe(() => {
        const next = get();
        if (Object.is(next, last)) return;
        last = next;
        listener();
      });
    },
  };
}

/** `serverTooOld` of one server as a store of its own. */
export function serverTooOldFor(controller: ClientStateController, origin: string): ReadableStore<boolean> {
  return factStore(controller, origin, (facts) => facts.serverTooOld);
}

const bannerKey = (origin: string): string => `oi.update-dismissed:${origin}`;
const reconcileNoticeKey = (origin: string): string => `oi.reconcile-unsupported-dismissed:${origin}`;

/**
 * Whether a stored dismissal (`<app version>|<recommended version or empty>`) still covers the current recommendation.
 * A dismissal made while only the header was known (no version) covers the same app version whatever compat later says, and a
 * dismissal against a version covers the same or an older recommendation; only a newer one, or a new app version, asks again.
 */
function covers(stored: string | null, appVersion: string, recommended: string | null): boolean {
  if (stored === null) return false;
  const cut = stored.lastIndexOf('|');
  if (cut < 0 || stored.slice(0, cut) !== appVersion) return false;
  const was = stored.slice(cut + 1);
  if (was === '' || recommended === null) return true;
  const order = compareVersions(recommended, was);
  return order === null ? recommended === was : order <= 0;
}

export function createClientState(deps: ClientStateDeps): ClientStateController {
  const store = createStore<ClientState>({ origins: new Map(), refreshes: 0 });
  /** Per decision and server: bumped by everything that changes what it depends on, so a slow read never overwrites a newer one. */
  const generations = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function bump(kind: 'banner' | 'notice', origin: string): number {
    const key = `${kind}|${origin}`;
    const next = (generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
  }

  function track(work: Promise<void>): void {
    const done = work.catch(() => undefined).finally(() => pending.delete(done));
    pending.add(done);
  }

  function set(origin: string, patch: Partial<OriginFacts>, extra: Partial<ClientState> = {}): void {
    const origins = new Map(store.get().origins);
    origins.set(origin, { ...factsFor(store.get(), origin), ...patch });
    store.patch({ origins, ...extra });
  }

  function decideBanner(origin: string): void {
    const mine = bump('banner', origin);
    const facts = factsFor(store.get(), origin);
    if (facts.upgrade !== 'recommended') {
      set(origin, { bannerVisible: false });
      return;
    }
    const recommended = facts.recommendedVersion;
    track(
      (async () => {
        let stored: string | null = null;
        try {
          stored = await deps.kv.get(bannerKey(origin));
        } catch {
          // Storage that cannot be read: show a banner that can be closed, rather than hide the news.
          stored = null;
        }
        if (mine === generations.get(`banner|${origin}`)) set(origin, { bannerVisible: !covers(stored, deps.appVersion, recommended) });
      })(),
    );
  }

  function decideReconcileNotice(origin: string): void {
    const mine = bump('notice', origin);
    if (factsFor(store.get(), origin).reconcileSupported !== false) {
      set(origin, { reconcileNoticeVisible: false });
      return;
    }
    track(
      (async () => {
        let stored: string | null = null;
        try {
          stored = await deps.kv.get(reconcileNoticeKey(origin));
        } catch {
          stored = null;
        }
        if (mine === generations.get(`notice|${origin}`)) set(origin, { reconcileNoticeVisible: stored === null });
      })(),
    );
  }

  function decideAll(origin: string): void {
    decideBanner(origin);
    decideReconcileNotice(origin);
  }

  return {
    store,
    noteUpgrade: (origin, value) => {
      if (value !== 'required' && value !== 'recommended') return;
      const before = factsFor(store.get(), origin).upgrade;
      if (value === 'required') {
        if (before === 'required') return;
        bump('banner', origin);
        set(origin, { upgrade: 'required', bannerVisible: false });
        return;
      }
      if (before !== 'none') return;
      set(origin, { upgrade: 'recommended' });
      decideAll(origin);
    },
    applyCompat: (origin, compat) => {
      const notices = compatNotices(compat, deps.appVersion);
      const upgrade: UpgradeLevel = notices.includes('update_required') ? 'required' : notices.includes('update_available') ? 'recommended' : 'none';
      set(
        origin,
        {
          upgrade,
          serverTooOld: compat.serverTooOld,
          downloadUrl: compat.downloadUrl,
          recommendedVersion: compat.recommended,
          reconcileSupported: compat.serverContractVersion >= MIN_CONTRACT_FOR_RECONCILE,
          compatKnown: true,
        },
        { refreshes: store.get().refreshes + 1 },
      );
      decideAll(origin);
    },
    noteCompatAttempt: () => {
      store.patch({ refreshes: store.get().refreshes + 1 });
    },
    noteReconcileUnsupported: (origin) => {
      if (factsFor(store.get(), origin).reconcileSupported === false) return;
      set(origin, { reconcileSupported: false });
      decideAll(origin);
    },
    dismissBanner: (origin) => {
      bump('banner', origin);
      const facts = factsFor(store.get(), origin);
      set(origin, { bannerVisible: false });
      const id = `${deps.appVersion}|${facts.recommendedVersion ?? ''}`;
      // A dismissal that cannot be stored is shown again next time; the banner is closed for now either way.
      track(Promise.resolve().then(() => deps.kv.set(bannerKey(origin), id)));
    },
    dismissReconcileNotice: (origin) => {
      bump('notice', origin);
      set(origin, { reconcileNoticeVisible: false });
      track(Promise.resolve().then(() => deps.kv.set(reconcileNoticeKey(origin), '1')));
    },
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
