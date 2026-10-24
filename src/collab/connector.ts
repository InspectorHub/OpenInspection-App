import type { CollabConnector as FieldCollabConnector, ResultsDocHandle } from '@inspectorhub/field-ui';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { parseServerUrl } from '../auth/server-config';
import type { Http, HttpResponse } from '../auth/http';
import { isAuthError } from '../auth/errors';
import type { TokenManager } from '../auth/tokens';
import type { Clock } from '../platform/clock';
import { systemClock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Network } from '../platform/network';
import { clearSyncProof, recordServerDeleteSet, recordServerStateVector } from './sync-proof';
import { realTimers, type TimerPort } from './timers';
import { SqlitePersistence, deleteDocRows, rethrowLater } from './y-sqlite';

/**
 * Frame prefix of a y-protocols sync message. The engine's inspection document object speaks the same two
 * frame kinds as the web build (`results-doc-connection`); there is no shared package, so the literals are
 * repeated here and must stay equal to the server's.
 */
const MSG_SYNC = 0;
/** A bare control frame: a version restore replaced the authoritative document, so drop local state and resync. */
const MSG_RESTORE = 2;

const RECONNECT_BASE_MS = 400;
const RECONNECT_MAX_MS = 30_000;
/** The longest a server's Retry-After may hold a reconnect. The http layer accepts up to an hour; a live edit session must not wait that long. */
const RETRY_AFTER_MAX_MS = 300_000;
/** Sockets in a row that closed before they opened, without any sync in between, after which the server counts as unreachable. */
const UNREACHABLE_AFTER = 5;
/** Consecutive ticket refusals (401) tolerated before the connection stops trying on its own. */
export const MAX_TICKET_REFUSALS = 3;

const INSPECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

/** Delay before reconnect attempt `attempt` (0-based): exponential, capped, with jitter of 50 to 100 percent. */
export function reconnectDelayMs(attempt: number, random: () => number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS);
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

/** The name the web build has always used for an inspection's results document. */
export function resultsDocName(inspectionId: string): string {
  return `results-${inspectionId}`;
}

export function isValidInspectionId(id: string): boolean {
  return INSPECTION_ID_PATTERN.test(id);
}

export type CollabStatus =
  | 'connecting'
  | 'open'
  | 'synced'
  | 'retrying'
  | 'offline'
  | 'locked'
  /** The server refuses this device for this inspection (403 or 404). Reconciliation decides what happens to the copy. */
  | 'denied'
  /** The server needs a newer app (426). */
  | 'upgrade_required'
  /** The token manager classified the session as over. */
  | 'signed_out'
  /** Tickets were refused several times in a row while the session still looked valid. */
  | 'auth_rejected'
  /** The stored state could not be read, so the document is never connected: its edits would not be saved. */
  | 'storage_failed'
  /** Several sockets in a row never opened and nothing synced. Still retrying, at the backoff ceiling. */
  | 'unreachable'
  /** The inspection is quarantined or being purged: the document is never opened and no ticket is asked for. */
  | 'blocked'
  | 'closed';

/** Reasons a connection stops trying until something outside it changes. */
type Halt = 'locked' | 'denied' | 'upgrade_required' | 'signed_out' | 'auth_rejected' | 'blocked';

/**
 * `connect` refused the inspection because it is quarantined or being purged (or because that could not be checked).
 * It is the rejection of `persistenceSynced`; the handle's document is never stored and never connected.
 */
export class CollabBlockedError extends Error {
  readonly code = 'blocked';
  constructor() {
    super('This inspection is not available on this device');
    this.name = 'CollabBlockedError';
  }
}

export interface SocketHandlers {
  open(): void;
  /** One binary frame. Text frames never reach this. */
  message(data: Uint8Array): void;
  close(): void;
}

export interface CollabSocket {
  isOpen(): boolean;
  send(data: Uint8Array): void;
  close(): void;
}

/** Opens a WebSocket to `url`. The real one is in `real.ts`; tests pass a fake. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => CollabSocket;

export interface CollabConnectorDeps {
  db: Db;
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  network: Network;
  /** The stored, canonical server origin. The only host a ticket or a socket is ever sent to. */
  origin: string;
  /** Development switch with the same meaning as for the server screen. */
  allowInsecureHttp?: boolean;
  /** True when the offline lock holds. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  openSocket: SocketFactory;
  timers?: TimerPort;
  random?: () => number;
  /** Receives storage failures and socket-construction failures. Never receives a ticket or a token. */
  onError?: (error: unknown) => void;
  onStatus?: (inspectionId: string, status: CollabStatus) => void;
  /**
   * Receives a failure to record what the server said about its copy (see `sync-proof.ts`). It never means data was
   * lost and never affects the sync: the document then simply keeps counting as not yet on the server. Receives
   * a fixed generic error only.
   */
  onProofError?: (error: unknown) => void;
  /** The time stamped on a sync proof. Defaults to the system clock. */
  clock?: Clock;
  /**
   * The data-layer block (`createBlockedGuard`). When given, a connection is made only after it answered `false`; an
   * answer of `true`, or a rejection, refuses the connection (see `CollabBlockedError`) and is asked again before every
   * ticket request. Without it nothing is checked: the composition root must pass the real guard.
   */
  isBlocked?: (inspectionId: string) => Promise<boolean>;
}

export interface NativeCollabConnector extends FieldCollabConnector {
  /** Call when the offline lock changed or the user signed in again: connections re-check and start or stop. */
  onLockChange(): void;
  /**
   * True while a connection for this inspection has not been destroyed. Code that would otherwise open the
   * document itself (the photo upload step, when no editor is open) asks first: there is one live connection per inspection.
   */
  isOpen(inspectionId: string): boolean;
  /**
   * Closes every live connection of one inspection and waits for the writes already started. Stored rows and the sync
   * proof stay: this is the quarantine's way to stop a connection, not a purge. Rejects with `RangeError` for an id that
   * could not be an inspection id.
   */
  closeFor(inspectionId: string): Promise<void>;
}

/** A connection that is still shutting down is tracked until it has finished, so a purge can wait for it. */
interface Entry {
  /** False once `close` was called, even while the connection is still finishing its writes. */
  active(): boolean;
  close(): Promise<void>;
  reevaluate(): void;
}

type TicketOutcome =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'retry'; afterMs: number | null }
  | { kind: 'halt'; reason: Halt };

function parseTicket(res: HttpResponse): string | null {
  const body = res.json;
  if (res.status !== 200 || typeof body !== 'object' || body === null) return null;
  const data = (body as { success?: unknown; data?: unknown }).data;
  if ((body as { success?: unknown }).success !== true || typeof data !== 'object' || data === null) return null;
  const ticket = (data as { ticket?: unknown }).ticket;
  return typeof ticket === 'string' && TICKET_PATTERN.test(ticket) ? ticket : null;
}

/** The ticket request URL and the results-document socket URL (without its ticket) for one inspection. */
export function collabEndpoints(origin: string, inspectionId: string): { ticket: string; socketBase: string } {
  const socketOrigin = origin.replace(/^http/, 'ws');
  return {
    ticket: `${origin}/api/inspections/${inspectionId}/collab/ticket`,
    socketBase: `${socketOrigin}/api/inspections/${inspectionId}/collab/ws`,
  };
}

/**
 * The native `CollabConnector`: the results document is opened from SQLite first; only then, and only while
 * the device is online and not locked, a one-time ticket is fetched and a WebSocket opened to the pinned
 * origin. Every reconnect fetches a new ticket. Nothing here ever deletes stored data except `purge`.
 *
 * Wiring requirements for the code that composes and uses this connector:
 *  - Pass an `onError` that tells the person their edits are not being saved. The default rethrows from a
 *    microtask, which is a crash report, not a message. A document whose stored state cannot be read reports
 *    the status `storage_failed` and is never connected. That status is sticky: every later status of the same
 *    connection (offline, locked, retrying, synced) is reported as `storage_failed` too, until the connection is
 *    destroyed, so a UI keyed on the latest status keeps warning that edits are not being saved. A failed write
 *    is not fatal (it is retried and reported through `onError`), so it does not set it.
 *  - Call `purge(id)` when reconciliation reports the status `denied`, and do not `connect` that inspection
 *    again while its purge is still awaiting: the new connection would load rows the purge is about to delete.
 *  - Call `onLockChange()` whenever the offline lock may have changed, in particular on unlock and after a
 *    sign-in; a connection that stopped for the lock starts again only through it.
 *  - One live connection per inspection: `connect` throws while the previous one has not been destroyed.
 *  - Presence is not served here. It needs its own ticketed socket path built from the pinned origin, because
 *    `FieldUrls.presenceSocket` is synchronous and cannot carry a ticket fetched over the network.
 */
export function createCollabConnector(deps: CollabConnectorDeps): NativeCollabConnector {
  // One canonical origin, the same rule as the server screen; a plain-http remote origin is refused here too.
  const origin = parseServerUrl(deps.origin, { allowInsecureHttp: deps.allowInsecureHttp === true });
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const report = deps.onError ?? rethrowLater;
  const clock = deps.clock ?? systemClock;
  const reportProof = (): void => {
    try {
      deps.onProofError?.(new Error('The sync proof could not be recorded'));
    } catch {
      // A failing reporter must not change what the connection does.
    }
  };
  /** Runs one proof write so that neither a throw nor a rejection can reach the sync. */
  const recordProof = (write: () => Promise<void>): void => {
    try {
      write().catch(reportProof);
    } catch {
      reportProof();
    }
  };
  const live = new Map<string, Set<Entry>>();

  function open(inspectionId: string, opts: { onChange?: () => void; onSynced?: () => void }): ResultsDocHandle {
    if (!isValidInspectionId(inspectionId)) throw new RangeError('Invalid inspection id');
    // Two live instances would each compact the same rows and each open a socket. One per inspection; a
    // connection that was destroyed but is still finishing its writes does not count.
    for (const other of live.get(inspectionId) ?? []) {
      if (other.active()) throw new Error('This inspection is already open; destroy the existing connection before connecting again');
    }
    const docName = resultsDocName(inspectionId);
    const endpoints = collabEndpoints(origin, inspectionId);

    let doc = new Y.Doc();
    /** Absent until the guard (when there is one) has answered `free`. */
    let persistence: SqlitePersistence | null = null;
    let socket: CollabSocket | null = null;
    let destroyed = false;
    let restoring = false;
    let synced = false;
    let halt: Halt | null = null;
    let busy = false;
    /** Something asked for a fresh attempt while one was running; the running one starts it when it ends. */
    let rerun = false;
    /** True once the stored state is applied. Nothing connects before it, and nothing ever does if it never is. */
    let persisted = false;
    let generation = 0;
    let attempts = 0;
    let refusals = 0;
    /** Sockets in a row that closed before they opened and with no sync since. */
    let neverOpened = 0;
    let retryTimer: unknown = null;
    let closing: Promise<void> | null = null;

    /** Set when the stored state could not be read; from then on no other status is reported but `closed`. */
    let storageFailed = false;

    const status = (value: CollabStatus): void => {
      deps.onStatus?.(inspectionId, storageFailed && value !== 'closed' ? 'storage_failed' : value);
    };

    function failStorage(): void {
      if (destroyed) return;
      storageFailed = true;
      status('storage_failed');
    }

    /** Runs a consumer callback so that an exception in it can never change what the connection does. */
    function notify(callback: (() => void) | undefined): void {
      try {
        callback?.();
      } catch {
        report(new Error('A collaboration callback failed'));
      }
    }

    /** Frames that arrived while a version restore was replacing the document; processed in order after the swap. */
    let queued: { data: Uint8Array; from: CollabSocket }[] = [];
    /** Counts lock evaluations; only the answer to the latest one is applied. */
    let lockEvaluation = 0;

    // ── local update forwarder ──────────────────────────────────────────────
    const forward = (update: Uint8Array, updateOrigin: unknown): void => {
      if (updateOrigin === socket || !socket?.isOpen()) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      socket.send(encoding.toUint8Array(encoder));
    };
    doc.on('update', forward);

    function sendStep1(): void {
      if (!socket?.isOpen()) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      socket.send(encoding.toUint8Array(encoder));
    }

    // ── timers ──────────────────────────────────────────────────────────────
    function clearRetry(): void {
      if (retryTimer === null) return;
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry(minimumMs: number | null): void {
      if (destroyed || halt !== null || retryTimer !== null) return;
      const delay = Math.max(reconnectDelayMs(attempts, random), Math.min(minimumMs ?? 0, RETRY_AFTER_MAX_MS));
      attempts += 1;
      status('retrying');
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        void attempt();
      }, delay);
    }

    function stop(reason: Halt): void {
      halt = reason;
      clearRetry();
      status(reason);
    }

    function dropSocket(): void {
      const current = socket;
      socket = null;
      current?.close();
    }

    // ── ticket ──────────────────────────────────────────────────────────────
    /** What the token manager makes of a refusal. A refusal never clears data and never loops. */
    async function refused(): Promise<TicketOutcome> {
      refusals += 1;
      const check = await deps.tokens.checkSession(origin);
      if (check.kind === 'relogin' || check.kind === 'signed_out') return { kind: 'halt', reason: 'signed_out' };
      if (refusals >= MAX_TICKET_REFUSALS) return { kind: 'halt', reason: 'auth_rejected' };
      return { kind: 'retry', afterMs: check.kind === 'retry' ? check.retryAfterMs : null };
    }

    async function requestTicket(): Promise<TicketOutcome> {
      let token: string | null;
      try {
        token = await deps.tokens.getAccessToken(origin);
      } catch {
        return { kind: 'retry', afterMs: null };
      }
      if (token === null) return refused();
      let res: HttpResponse;
      try {
        res = await deps.http.request({ url: endpoints.ticket, method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (isAuthError(err)) return { kind: 'retry', afterMs: null };
        throw err;
      }
      if (res.status === 401) return refused();
      if (res.status === 403 || res.status === 404) return { kind: 'halt', reason: 'denied' };
      if (res.status === 426) return { kind: 'halt', reason: 'upgrade_required' };
      const ticket = parseTicket(res);
      if (ticket === null) return { kind: 'retry', afterMs: res.retryAfterMs };
      refusals = 0;
      return { kind: 'ticket', ticket };
    }

    // ── socket ──────────────────────────────────────────────────────────────
    function openSocket(ticket: string): void {
      const target = `${endpoints.socketBase}?ticket=${encodeURIComponent(ticket)}`;
      let created: CollabSocket;
      let opened = false;
      try {
        created = deps.openSocket(target, {
          open: () => {
            if (socket !== created || destroyed) return;
            opened = true;
            status('open');
            sendStep1();
          },
          message: (data) => {
            if (socket !== created || destroyed) return;
            // The document is being replaced: an answer now would come from the one being thrown away.
            if (restoring) {
              queued.push({ data, from: created });
              return;
            }
            handleFrame(data, created);
          },
          close: () => {
            if (socket !== created) return;
            socket = null;
            // While a restore swaps the document the socket must not come back on the old one; the restore
            // reconnects when it is done.
            if (destroyed || halt !== null || restoring) return;
            scheduleRetry(null);
            if (!opened) {
              neverOpened += 1;
              if (neverOpened >= UNREACHABLE_AFTER) status('unreachable');
            }
          },
        });
      } catch {
        // The platform's message names the URL, and the URL carries the ticket.
        report(new Error('The collaboration socket could not be opened'));
        scheduleRetry(null);
        return;
      }
      socket = created;
    }

    /** A frame that cannot be read says nothing about the document: report it, drop the socket, let the backoff reconnect. */
    function handleFrame(data: Uint8Array, from: CollabSocket): void {
      try {
        onFrame(data, from);
      } catch {
        report(new Error('A collaboration frame could not be read'));
        dropSocket();
        // A restore reconnects when it is done.
        if (!restoring) scheduleRetry(null);
      }
    }

    /**
     * Applies an update the way `syncProtocol.readSyncMessage` does, with one difference in what is thrown. A
     * malformed update throws to the caller, which drops the socket. An exception from a Yjs observer or an
     * `update` listener (the update IS applied by then) says nothing about the frame: it is reported on its own
     * and the sync carries on. The two are told apart by decoding the same bytes again, which only the
     * malformed case fails.
     */
    function applyRemoteUpdate(update: Uint8Array, from: CollabSocket): void {
      try {
        // The socket is the transaction origin, so the forwarder does not send the server its own update back.
        Y.applyUpdate(doc, update, from);
      } catch {
        Y.decodeUpdate(update);
        report(new Error('A collaboration update handler failed'));
      }
    }

    function onFrame(data: Uint8Array, from: CollabSocket): void {
      if (data.length === 0) return;
      const decoder = decoding.createDecoder(data);
      const kind = decoding.readVarUint(decoder);
      if (kind === MSG_RESTORE) {
        void handleRestore();
        return;
      }
      if (kind !== MSG_SYNC) return;
      // Decode first: everything that throws before the update is applied is a frame that cannot be read.
      const messageType = decoding.readVarUint(decoder);
      if (
        messageType !== syncProtocol.messageYjsSyncStep1 &&
        messageType !== syncProtocol.messageYjsSyncStep2 &&
        messageType !== syncProtocol.messageYjsUpdate
      ) {
        throw new Error('Unknown sync message type');
      }
      const payload = decoding.readVarUint8Array(decoder);
      if (messageType === syncProtocol.messageYjsSyncStep1) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        syncProtocol.writeSyncStep2(reply, doc, payload);
        if (from.isOpen()) from.send(encoding.toUint8Array(reply));
        // The server has just told us what it holds. This, and the deleted ranges of its step 2 below, are the only
        // things ever recorded as proof: what this device sends is not.
        const observed = payload.slice();
        recordProof(() => recordServerStateVector(deps.db, docName, observed, clock.now()));
        return;
      }
      applyRemoteUpdate(payload, from);
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        const observed = payload.slice();
        recordProof(() => recordServerDeleteSet(deps.db, docName, observed, clock.now()));
        attempts = 0;
        neverOpened = 0;
        if (!synced) {
          synced = true;
          notify(opts.onChange);
        }
        status('synced');
        notify(opts.onSynced);
      }
    }

    /**
     * A version restore: Yjs updates only add, so edits made since could never be undone by merging. Drop the
     * document and its stored rows and pull the restored state on the open socket.
     */
    async function handleRestore(): Promise<void> {
      if (destroyed || restoring || persistence === null) return;
      restoring = true;
      try {
        doc.off('update', forward);
        const old = persistence;
        const oldDoc = doc;
        await old.destroy();
        if (destroyed) return;
        try {
          await old.clearData();
        } catch (error) {
          // As on the web: a failed clear must not wedge the resync. It is reported, not hidden.
          report(error);
        }
        // What the server said about the replaced document describes a document that no longer exists here.
        try {
          await clearSyncProof(deps.db, docName);
        } catch {
          reportProof();
        }
        if (destroyed) return;
        doc = new Y.Doc();
        persistence = new SqlitePersistence(deps.db, docName, doc, { onError: report, timers });
        persistence.whenSynced.then(undefined, failStorage);
        doc.on('update', forward);
        oldDoc.destroy();
        synced = false;
        notify(opts.onChange);
        sendStep1();
      } finally {
        restoring = false;
        drainQueued();
        // A socket that closed during the restore was not retried; do it now that the document is whole.
        if (!destroyed && halt === null && socket === null && retryTimer === null && !busy) scheduleRetry(null);
      }
    }

    /** Processes the frames held back during a restore, in order, on the new document. Frames of a dead socket are dropped. */
    function drainQueued(): void {
      const batch = queued;
      queued = [];
      for (let i = 0; i < batch.length; i += 1) {
        if (destroyed) return;
        if (restoring) {
          // Another restore started inside this batch: what is left waits for it.
          queued = [...batch.slice(i), ...queued];
          return;
        }
        const item = batch[i];
        if (item && socket === item.from) handleFrame(item.data, item.from);
      }
    }

    // ── one connection attempt ───────────────────────────────────────────────
    async function attempt(): Promise<void> {
      if (destroyed || !persisted || socket !== null) return;
      if (busy) {
        rerun = true;
        return;
      }
      busy = true;
      const mine = ++generation;
      const stale = (): boolean => destroyed || mine !== generation || halt !== null;
      try {
        let locked: boolean;
        const evaluation = ++lockEvaluation;
        try {
          locked = await deps.isLocked();
        } catch {
          locked = true;
        }
        if (destroyed) return;
        // A lock event evaluated while this was waiting; its answer is newer and starts over if need be.
        if (evaluation !== lockEvaluation) return;
        if (locked) {
          stop('locked');
          return;
        }
        if (!(await deps.network.online())) {
          if (!destroyed) status('offline');
          return;
        }
        if (stale()) return;
        if (await blockedNow()) {
          if (!stale()) stop('blocked');
          return;
        }
        if (stale()) return;
        status('connecting');
        const outcome = await requestTicket();
        if (stale()) return;
        if (outcome.kind === 'halt') stop(outcome.reason);
        else if (outcome.kind === 'retry') scheduleRetry(outcome.afterMs);
        else openSocket(outcome.ticket);
      } catch (error) {
        report(error);
        if (!stale()) scheduleRetry(null);
      } finally {
        busy = false;
        // The network or the lock changed while this attempt was waiting. Whatever it found is out of date, so
        // start over rather than leave the connection with no socket and no timer until the next event.
        if (rerun) {
          rerun = false;
          if (!destroyed && halt === null && socket === null) {
            clearRetry();
            void attempt();
          }
        }
      }
    }

    /** True when the guard says blocked, or cannot say. Without a guard nothing is blocked. */
    async function blockedNow(): Promise<boolean> {
      if (deps.isBlocked === undefined) return false;
      try {
        return (await deps.isBlocked(inspectionId)) !== false;
      } catch {
        return true;
      }
    }

    function restart(): void {
      attempts = 0;
      neverOpened = 0;
      clearRetry();
      void attempt();
    }

    const stopOnNetwork = deps.network.onChange((online) => {
      if (destroyed) return;
      if (!online) {
        generation += 1;
        clearRetry();
        dropSocket();
        status('offline');
        return;
      }
      if (halt !== null && halt !== 'locked') return;
      halt = null;
      restart();
    });

    function reevaluate(): void {
      if (destroyed) return;
      void (async () => {
        let locked: boolean;
        const evaluation = ++lockEvaluation;
        try {
          locked = await deps.isLocked();
        } catch {
          locked = true;
        }
        if (destroyed || evaluation !== lockEvaluation) return;
        if (locked) {
          generation += 1;
          dropSocket();
          stop('locked');
          return;
        }
        halt = null;
        refusals = 0;
        if (socket === null) restart();
      })();
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    function close(): Promise<void> {
      if (closing) return closing;
      destroyed = true;
      generation += 1;
      clearRetry();
      stopOnNetwork();
      doc.off('update', forward);
      dropSocket();
      const finishing = persistence?.destroy() ?? Promise.resolve();
      doc.destroy();
      status('closed');
      closing = finishing.finally(() => {
        const group = live.get(inspectionId);
        group?.delete(entry);
        if (group?.size === 0) live.delete(inspectionId);
      });
      return closing;
    }

    const entry: Entry = { active: () => !destroyed, close, reevaluate };
    const group = live.get(inspectionId) ?? new Set<Entry>();
    group.add(entry);
    live.set(inspectionId, group);

    let markPersisted: () => void = () => undefined;
    let refusePersisted: (reason: unknown) => void = () => undefined;
    // A store that fails to open leaves this pending and never opens the socket: the editor must not open on an
    // empty document whose edits would not be saved. The failure itself has already been reported. A blocked
    // inspection rejects it instead, with a typed error.
    const persistenceSynced = new Promise<void>((resolve, reject) => {
      markPersisted = resolve;
      refusePersisted = reject;
    });
    // A caller that never awaits the handle must not produce an unhandled rejection for a refusal.
    persistenceSynced.catch(() => undefined);

    function startPersistence(): void {
      if (destroyed) return;
      const created = new SqlitePersistence(deps.db, docName, doc, { onError: report, timers });
      persistence = created;
      created.whenSynced.then(
        () => {
          persisted = true;
          markPersisted();
          if (destroyed) return;
          notify(opts.onChange);
          void attempt();
        },
        failStorage,
      );
    }

    /** The document is never read, stored or connected: the handle only reports why. */
    function refuseBlocked(): void {
      status('blocked');
      refusePersisted(new CollabBlockedError());
      void close();
    }

    if (deps.isBlocked === undefined) {
      startPersistence();
    } else {
      void (async () => {
        const blocked = await blockedNow();
        // A purge or a destroy that came first already closed this connection; nothing is started for it.
        if (destroyed) return;
        if (blocked) refuseBlocked();
        else startPersistence();
      })();
    }

    return {
      get doc() {
        return doc;
      },
      persistenceSynced,
      synced: () => synced,
      destroy: () => {
        void close();
      },
    };
  }

  return {
    connect: (inspectionId, opts) => open(inspectionId, opts),
    purge: async (inspectionId) => {
      if (!isValidInspectionId(inspectionId)) throw new RangeError('Invalid inspection id');
      // Close first and wait: a write still in flight must land before the rows are deleted, not after.
      await Promise.all([...(live.get(inspectionId) ?? [])].map((entry) => entry.close()));
      // One transaction: the rows and their proof go together or not at all. A stale marker must never outlive the
      // rows it described, and a failure to clear it must not leave the rows deleted while the purge reports failure.
      await deps.db.transaction(async (tx) => {
        await deleteDocRows(tx, resultsDocName(inspectionId));
        await clearSyncProof(tx, resultsDocName(inspectionId));
      });
    },
    closeFor: async (inspectionId) => {
      if (!isValidInspectionId(inspectionId)) throw new RangeError('Invalid inspection id');
      await Promise.all([...(live.get(inspectionId) ?? [])].map((entry) => entry.close()));
    },
    onLockChange: () => {
      for (const group of live.values()) for (const entry of group) entry.reevaluate();
    },
    isOpen: (inspectionId) => [...(live.get(inspectionId) ?? [])].some((entry) => entry.active()),
  };
}
