import type { CollabConnector as FieldCollabConnector, ResultsDocHandle } from '@inspectorhub/field-ui';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { parseServerUrl } from '../auth/server-config';
import type { Http, HttpResponse } from '../auth/http';
import { isAuthError } from '../auth/errors';
import type { TokenManager } from '../auth/tokens';
import type { Db } from '../platform/db';
import type { Network } from '../platform/network';
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
  | 'closed';

/** Reasons a connection stops trying until something outside it changes. */
type Halt = 'locked' | 'denied' | 'upgrade_required' | 'signed_out' | 'auth_rejected';

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
}

export interface NativeCollabConnector extends FieldCollabConnector {
  /** Call when the offline lock changed or the user signed in again: connections re-check and start or stop. */
  onLockChange(): void;
}

/** A connection that is still shutting down is tracked until it has finished, so a purge can wait for it. */
interface Entry {
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

/** The ticket request and socket URL for the collab socket of one inspection; also what a presence socket needs. */
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
 */
export function createCollabConnector(deps: CollabConnectorDeps): NativeCollabConnector {
  // One canonical origin, the same rule as the server screen; a plain-http remote origin is refused here too.
  const origin = parseServerUrl(deps.origin, { allowInsecureHttp: deps.allowInsecureHttp === true });
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const report = deps.onError ?? rethrowLater;
  const live = new Map<string, Set<Entry>>();

  function open(inspectionId: string, opts: { onChange?: () => void; onSynced?: () => void }): ResultsDocHandle {
    if (!isValidInspectionId(inspectionId)) throw new RangeError('Invalid inspection id');
    const docName = resultsDocName(inspectionId);
    const endpoints = collabEndpoints(origin, inspectionId);

    let doc = new Y.Doc();
    let persistence = new SqlitePersistence(deps.db, docName, doc, { onError: report, timers });
    let socket: CollabSocket | null = null;
    let destroyed = false;
    let restoring = false;
    let synced = false;
    let halt: Halt | null = null;
    let busy = false;
    let generation = 0;
    let attempts = 0;
    let refusals = 0;
    let retryTimer: unknown = null;
    let closing: Promise<void> | null = null;

    const status = (value: CollabStatus): void => {
      deps.onStatus?.(inspectionId, value);
    };

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
      const delay = Math.max(reconnectDelayMs(attempts, random), minimumMs ?? 0);
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
      try {
        created = deps.openSocket(target, {
          open: () => {
            if (socket !== created || destroyed) return;
            status('open');
            sendStep1();
          },
          message: (data) => {
            if (socket === created && !destroyed) onFrame(data, created);
          },
          close: () => {
            if (socket !== created) return;
            socket = null;
            if (destroyed || halt !== null) return;
            scheduleRetry(null);
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

    function onFrame(data: Uint8Array, from: CollabSocket): void {
      if (data.length === 0) return;
      const decoder = decoding.createDecoder(data);
      const kind = decoding.readVarUint(decoder);
      if (kind === MSG_RESTORE) {
        void handleRestore();
        return;
      }
      if (kind !== MSG_SYNC) return;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      // The socket is the transaction origin, so the forwarder does not send the server its own update back.
      const messageType = syncProtocol.readSyncMessage(decoder, reply, doc, from);
      if (messageType === syncProtocol.messageYjsSyncStep1 && from.isOpen()) from.send(encoding.toUint8Array(reply));
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        attempts = 0;
        if (!synced) {
          synced = true;
          opts.onChange?.();
        }
        status('synced');
        opts.onSynced?.();
      }
    }

    /**
     * A version restore: Yjs updates only add, so edits made since could never be undone by merging. Drop the
     * document and its stored rows and pull the restored state on the open socket.
     */
    async function handleRestore(): Promise<void> {
      if (destroyed || restoring) return;
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
        if (destroyed) return;
        doc = new Y.Doc();
        persistence = new SqlitePersistence(deps.db, docName, doc, { onError: report, timers });
        doc.on('update', forward);
        oldDoc.destroy();
        synced = false;
        opts.onChange?.();
        sendStep1();
      } finally {
        restoring = false;
      }
    }

    // ── one connection attempt ───────────────────────────────────────────────
    async function attempt(): Promise<void> {
      if (destroyed || busy || socket !== null) return;
      busy = true;
      const mine = ++generation;
      const stale = (): boolean => destroyed || mine !== generation || halt !== null;
      try {
        let locked: boolean;
        try {
          locked = await deps.isLocked();
        } catch {
          locked = true;
        }
        if (destroyed) return;
        if (locked) {
          stop('locked');
          return;
        }
        if (!(await deps.network.online())) {
          if (!destroyed) status('offline');
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
      }
    }

    function restart(): void {
      attempts = 0;
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
        try {
          locked = await deps.isLocked();
        } catch {
          locked = true;
        }
        if (destroyed) return;
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
      const finishing = persistence.destroy();
      doc.destroy();
      status('closed');
      closing = finishing.finally(() => {
        const group = live.get(inspectionId);
        group?.delete(entry);
        if (group?.size === 0) live.delete(inspectionId);
      });
      return closing;
    }

    const entry: Entry = { close, reevaluate };
    const group = live.get(inspectionId) ?? new Set<Entry>();
    group.add(entry);
    live.set(inspectionId, group);

    const firstPersistence = persistence;
    // A store that fails to open leaves this pending and never opens the socket: the editor must not open on an
    // empty document whose edits would not be saved. The failure itself has already been reported.
    const persistenceSynced = new Promise<void>((resolve) => {
      firstPersistence.whenSynced.then(
        () => {
          resolve();
          if (destroyed) return;
          opts.onChange?.();
          void attempt();
        },
        () => undefined,
      );
    });

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
      await deleteDocRows(deps.db, resultsDocName(inspectionId));
    },
    onLockChange: () => {
      for (const group of live.values()) for (const entry of group) entry.reevaluate();
    },
  };
}
