import type { CommandResult, InspectionPrefs } from '@inspectorhub/field-ui';
import { writeDeviceState } from '../auth/server-config';
import { accountKey, type Account } from '../offline/outbox';
import type { Db } from '../platform/db';
import type { Api } from './api-client';
import { isRec } from './commands-shared';
import { MESSAGES, failureOf } from './messages';
import { writeFailure } from './resources-shared';

/**
 * The company's editor preferences as this device holds them: the last value the server gave, plus the changes made here
 * that the server has not heard yet.
 *
 * The preference belongs to the company, not to the person or the device, so there is exactly one stored value per
 * account. It lives in one `device_state` row under the declared `inspection_prefs:` family, not in `resource_cache`: the
 * background refresh replaces that table's whole global set on every run, which would drop a change that was waiting to be
 * sent. A clear removes the row with the rest of the account's data, and a row per account key never mixes two accounts.
 *
 * Stored value: `{ prefs, pending }`. `prefs` is the last validated server answer (null when none was ever read) and
 * `pending` holds only the fields changed on this device. What the editor and the settings screen show is `prefs` with
 * `pending` laid over it. A pending field is removed once the server accepted it, or for good when the server refused it
 * permanently; the next read then adopts the server's value, so the device never keeps a value the company does not have.
 * Last write wins per field.
 */

export const PREFS_ROUTE = '/api/tenant/inspection-prefs';

/** What the store needs to know about the preference's shape; the shape itself stays with `resources-library.ts`. */
export interface PrefsCodec {
  /** The preferences from a server (or stored) body, field by field over the defaults; null for a body that is not an object. */
  parse(json: unknown): InspectionPrefs | null;
  /** A fresh copy of the built-in defaults. */
  defaults(): InspectionPrefs;
}

export interface PrefsStoreDeps {
  api: Api;
  db: Db;
  account: Account;
  /** Link state, synchronously. */
  isOnline(): boolean;
}

export interface PrefsView {
  prefs: InspectionPrefs;
  /** True while a change made on this device has not reached the company. */
  pending: boolean;
}

export interface PrefsStore {
  /** The editor's `prefs.load`: the server's value when it can be read, else the stored one, else the defaults. */
  load(): Promise<InspectionPrefs>;
  /** The editor's `prefs.patch`. Accepted locally when the server cannot be asked; refused changes are not kept. */
  patch(delta: Partial<InspectionPrefs>): Promise<CommandResult<InspectionPrefs>>;
  /** Sends what is waiting, if anything and if the device is online. Never rejects. */
  flush(): Promise<void>;
  /** The settings screen's read: like `load`, with the waiting flag. */
  read(): Promise<PrefsView>;
  /** What is stored, with no request: for a screen that is told something changed. */
  peek(): Promise<PrefsView>;
  /** Calls the listener after this object changed what is stored. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

interface State {
  prefs: InspectionPrefs | null;
  pending: Partial<InspectionPrefs>;
}

type Verdict = 'sent' | 'refused' | 'later';

/** Only the status decides; no server text is kept. 401 is the session, not the change, so it waits like a lost answer. */
function verdictOf(outcome: Awaited<ReturnType<Api['send']>>): Verdict {
  if (outcome.kind === 'problem') return 'later';
  const { status } = outcome;
  if (status >= 200 && status < 300) return 'sent';
  if (status === 401 || status === 408 || status === 425 || status === 429 || status >= 500) return 'later';
  return 'refused';
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createPrefsStore(deps: PrefsStoreDeps, codec: PrefsCodec): PrefsStore {
  const key = `inspection_prefs:${accountKey(deps.account)}`;
  const listeners = new Set<() => void>();
  const fields = Object.keys(codec.defaults()) as (keyof InspectionPrefs)[];
  /** One operation at a time in this object, so a load and a change made together cannot interleave their reads and writes. */
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  /** The fields of `delta` that are valid preferences, each checked alone against the codec. */
  function validDelta(delta: Record<string, unknown>): Partial<InspectionPrefs> {
    const kept: Partial<InspectionPrefs> = {};
    for (const field of fields) {
      if (!(field in delta)) continue;
      const checked = codec.parse({ [field]: delta[field] });
      if (checked !== null && same(checked[field], delta[field])) Object.assign(kept, { [field]: checked[field] });
    }
    return kept;
  }

  function parseState(value: string | undefined): State {
    const empty: State = { prefs: null, pending: {} };
    if (value === undefined) return empty;
    try {
      const raw: unknown = JSON.parse(value);
      if (!isRec(raw)) return empty;
      return { prefs: raw.prefs === null || raw.prefs === undefined ? null : codec.parse(raw.prefs), pending: isRec(raw.pending) ? validDelta(raw.pending) : {} };
    } catch {
      return empty;
    }
  }

  async function readState(db: Db): Promise<State> {
    try {
      const rows = await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]);
      return parseState(rows[0]?.value);
    } catch {
      return { prefs: null, pending: {} };
    }
  }

  /** Changes the stored state in one transaction from what is stored at that moment, so a send that finished late cannot undo a newer change. */
  async function update(change: (state: State) => State, notify = true): Promise<State> {
    const next = await deps.db.transaction(async (tx) => {
      const rows = await tx.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]);
      const state = change(parseState(rows[0]?.value));
      await writeDeviceState(tx, key, JSON.stringify(state));
      return state;
    });
    // A read that stores what it found must not tell the screen that is reading: that screen would read again, forever.
    for (const listener of notify ? [...listeners] : []) {
      try {
        listener();
      } catch {
        // a listener's failure is its own
      }
    }
    return next;
  }

  function shown(state: State): InspectionPrefs {
    const base = state.prefs ?? codec.defaults();
    return codec.parse({ ...base, ...state.pending }) ?? codec.defaults();
  }

  /** Removes from `pending` the fields that still hold exactly the value that was sent (a newer value for one stays). */
  function without(pending: Partial<InspectionPrefs>, sent: Partial<InspectionPrefs>): Partial<InspectionPrefs> {
    const rest: Partial<InspectionPrefs> = { ...pending };
    for (const field of fields) if (field in sent && same(rest[field], sent[field])) delete rest[field];
    return rest;
  }

  /** `pending` without the fields `newer` names, whatever their waiting value. */
  function omit(pending: Partial<InspectionPrefs>, newer: Partial<InspectionPrefs>): Partial<InspectionPrefs> {
    const rest: Partial<InspectionPrefs> = { ...pending };
    for (const field of fields) if (field in newer) delete rest[field];
    return rest;
  }

  /** Sends the waiting change. 'none': nothing waited or nothing could be tried; otherwise what the server decided. */
  async function sendPending(notify = true): Promise<Verdict | 'none'> {
    const state = await readState(deps.db);
    const sent = state.pending;
    if (Object.keys(sent).length === 0 || !deps.isOnline()) return 'none';
    let verdict: Verdict;
    let body: unknown;
    try {
      const outcome = await deps.api.send({ method: 'PATCH', path: PREFS_ROUTE, json: sent });
      verdict = verdictOf(outcome);
      body = outcome.kind === 'response' ? outcome.json : undefined;
    } catch {
      return 'later';
    }
    if (verdict === 'later') return verdict;
    const answered = verdict === 'sent' ? codec.parse(body) : null;
    await update((current) => ({ prefs: answered ?? current.prefs, pending: without(current.pending, sent) }), notify);
    return verdict;
  }

  async function peekNow(): Promise<PrefsView> {
    const state = await readState(deps.db);
    return { prefs: shown(state), pending: Object.keys(state.pending).length > 0 };
  }

  async function readNow(): Promise<PrefsView> {
    try {
      if (deps.isOnline()) {
        await sendPending(false);
        const outcome = await deps.api.send({ method: 'GET', path: PREFS_ROUTE });
        if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
          const fresh = codec.parse(outcome.json);
          if (fresh !== null) {
            const next = await update((current) => ({ prefs: fresh, pending: current.pending }), false);
            return { prefs: shown(next), pending: Object.keys(next.pending).length > 0 };
          }
        }
      }
    } catch {
      // a failed read falls through to the stored copy
    }
    return peekNow();
  }

  async function patchNow(delta: Partial<InspectionPrefs>): Promise<CommandResult<InspectionPrefs>> {
    const change = validDelta(delta);
    // Nothing valid to save: say so instead of reporting success for a change nobody stored or sent.
    if (Object.keys(change).length === 0) return failureOf(MESSAGES.prefsNotSaved);
    const locally = async (): Promise<CommandResult<InspectionPrefs>> => {
      try {
        const next = await update((current) => ({ prefs: current.prefs, pending: { ...current.pending, ...change } }));
        return { ok: true, data: shown(next) };
      } catch {
        return failureOf(MESSAGES.prefsNotSaved);
      }
    };
    if (!deps.isOnline()) return locally();
    // An older waiting change goes first, so the newer value for the same field is the one the server ends with.
    try {
      await sendPending();
    } catch {
      // it stays waiting
    }
    let outcome: Awaited<ReturnType<Api['send']>>;
    try {
      outcome = await deps.api.send({ method: 'PATCH', path: PREFS_ROUTE, json: change });
    } catch {
      return locally();
    }
    const verdict = verdictOf(outcome);
    if (verdict === 'later') return locally();
    if (verdict === 'refused') return writeFailure(outcome, MESSAGES.prefsNotSaved);
    const answered = outcome.kind === 'response' ? codec.parse(outcome.json) : null;
    try {
      // The server now holds this value, which is newer than anything waiting for the same field, whether or not its
      // answer carried a body: an older waiting value must not be sent later over it.
      const next = await update((current) => ({ prefs: answered ?? current.prefs, pending: omit(current.pending, change) }));
      return { ok: true, data: shown(next) };
    } catch {
      return answered === null ? { ok: true } : { ok: true, data: answered };
    }
  }

  return {
    load: () => exclusive(async () => (await readNow()).prefs),
    read: () => exclusive(readNow),
    peek: () => exclusive(peekNow),
    patch: (delta) => exclusive(() => patchNow(delta)),
    flush: () =>
      exclusive(async () => {
        try {
          await sendPending();
        } catch {
          // the change stays waiting
        }
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
