import type { CompatInfo } from '../auth/server-config';
import type { KeyValue } from '../platform/kv';
import { compatNotices } from './compat-notice';
import { createStore, type ReadableStore } from './stack-store';

/** What the server asks of this app version: nothing, an update when convenient, or an update before more editing. */
export type UpgradeLevel = 'none' | 'recommended' | 'required';

/**
 * What the app has learned about the server it is signed in to, for the interface and the editor gate. Every fact belongs to
 * `origin`: a reader for another server must ignore it (`clientPolicy` does). Nothing here is persisted except the dismissal
 * of the recommended banner, and nothing here is read by a sync flow except `serverTooOld`.
 */
export interface ClientState {
  origin: string | null;
  upgrade: UpgradeLevel;
  /** The server speaks an older contract than this app needs. False when it is not known: an unanswered request proves nothing. */
  serverTooOld: boolean;
  /** Where to get the update, as the compat answer gave it (already https-only; still re-checked when it is opened). */
  downloadUrl: string | null;
  /** The newest version the server recommends, when the compat answer said. */
  recommendedVersion: string | null;
  /** True while the "update available" banner should show: recommended, and not dismissed for this app version and recommendation. */
  bannerVisible: boolean;
  /** Counts compat attempts, answered or not; what the interface re-reads its time-based notices on. */
  refreshes: number;
}

export interface ClientStateController {
  readonly store: ReadableStore<ClientState>;
  /** An `X-Client-Upgrade` value, or a 426, seen on a response from `origin`. Values other than `required` and `recommended` are ignored. */
  noteUpgrade(origin: string, value: string): void;
  /** A compat answer from `origin`. Authoritative: it replaces every earlier signal from that server. */
  applyCompat(origin: string, compat: CompatInfo): void;
  /** A compat request that got no usable answer. Changes no fact. */
  noteCompatAttempt(origin: string): void;
  /** The person closed the banner: not shown again for this app version and recommendation on this server. */
  dismissBanner(): void;
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
  const mine = state.origin === origin;
  return { canEdit: !(mine && state.upgrade === 'required'), canSync: !(mine && state.serverTooOld), canExport: true };
}

/** `serverTooOld` of one server as a store of its own, for the offline stack. */
export function serverTooOldFor(controller: ClientStateController, origin: string): ReadableStore<boolean> {
  const read = (): boolean => {
    const state = controller.store.get();
    return state.origin === origin && state.serverTooOld;
  };
  return {
    get: read,
    subscribe: (listener) => {
      let last = read();
      return controller.store.subscribe(() => {
        const next = read();
        if (next === last) return;
        last = next;
        listener();
      });
    },
  };
}

const dismissedKey = (origin: string): string => `oi.update-dismissed:${origin}`;

export function createClientState(deps: ClientStateDeps): ClientStateController {
  const store = createStore<ClientState>({ origin: null, upgrade: 'none', serverTooOld: false, downloadUrl: null, recommendedVersion: null, bannerVisible: false, refreshes: 0 });
  /** Bumped by everything that changes what the banner depends on, so a slow read never overwrites a newer decision. */
  let generation = 0;
  const pending = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    const done = work.catch(() => undefined).finally(() => pending.delete(done));
    pending.add(done);
  }

  /** What was dismissed: the app version and the recommendation it was dismissed against. */
  function dismissalId(state: ClientState): string {
    return `${deps.appVersion}|${state.recommendedVersion ?? ''}`;
  }

  /** Moves to `origin`. A server other than the one the facts are about starts from nothing. */
  function enter(origin: string): void {
    if (store.get().origin === origin) return;
    generation += 1;
    store.patch({ origin, upgrade: 'none', serverTooOld: false, downloadUrl: null, recommendedVersion: null, bannerVisible: false });
  }

  function decideBanner(): void {
    generation += 1;
    const mine = generation;
    const state = store.get();
    if (state.upgrade !== 'recommended' || state.origin === null) {
      store.patch({ bannerVisible: false });
      return;
    }
    const origin = state.origin;
    const id = dismissalId(state);
    track(
      (async () => {
        let stored: string | null = null;
        try {
          stored = await deps.kv.get(dismissedKey(origin));
        } catch {
          // Storage that cannot be read: show a banner that can be closed, rather than hide the news.
          stored = null;
        }
        if (mine === generation) store.patch({ bannerVisible: stored !== id });
      })(),
    );
  }

  return {
    store,
    noteUpgrade: (origin, value) => {
      if (value !== 'required' && value !== 'recommended') return;
      enter(origin);
      const before = store.get().upgrade;
      if (value === 'required') {
        if (before === 'required') return;
        generation += 1;
        store.patch({ upgrade: 'required', bannerVisible: false });
        return;
      }
      if (before !== 'none') return;
      store.patch({ upgrade: 'recommended' });
      decideBanner();
    },
    applyCompat: (origin, compat) => {
      enter(origin);
      const notices = compatNotices(compat, deps.appVersion);
      const upgrade: UpgradeLevel = notices.includes('update_required') ? 'required' : notices.includes('update_available') ? 'recommended' : 'none';
      store.patch({ upgrade, serverTooOld: compat.serverTooOld, downloadUrl: compat.downloadUrl, recommendedVersion: compat.recommended, refreshes: store.get().refreshes + 1 });
      decideBanner();
    },
    noteCompatAttempt: () => {
      store.patch({ refreshes: store.get().refreshes + 1 });
    },
    dismissBanner: () => {
      generation += 1;
      const state = store.get();
      store.patch({ bannerVisible: false });
      if (state.origin === null) return;
      const origin = state.origin;
      const id = dismissalId(state);
      // A dismissal that cannot be stored is shown again next time; the banner is closed for now either way.
      track(Promise.resolve().then(() => deps.kv.set(dismissedKey(origin), id)));
    },
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
