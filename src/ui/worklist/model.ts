import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoundUserActions, OfflineStack, ReconcilerHandle } from '../../app/offline-stack';
import { appTimings } from '../../app/timings';
import type { MediaStore } from '../../media/store';
import type { Db } from '../../platform/db';
import { loadTenantName } from '../../offline/lock-state';
import { accountKey, listOutbox, outboxCountsByInspection, sameAccount, type Account } from '../../offline/outbox';
import { readPackageRows, readPackageStates, type RefreshErrorCode } from '../../offline/package-targets';
import { namesMassSuspicious } from '../../offline/purge';
import { planIsStale, type ReconcilePlan } from '../../offline/reconcile-decision';
import type { ReconcileOutcome } from '../../offline/reconciler';
import { DEFAULT_REGISTRY, isLocalId } from '../../offline/registry';
import type { UnattributableRow } from '../../offline/user-actions';
import { OUTBOX_ERROR_CODES, type OutboxErrorCode } from '../../platform/schema';
import { groupOf, shortTitle, stripBidi, type GroupKey } from './format';

/** What the work list reads from the stack. A pick, so a test can stand in for any part. */
export type WorkListStack = Pick<OfflineStack, 'db' | 'account' | 'status' | 'markListPainted' | 'replayer' | 'refresher' | 'reconciler' | 'uploader' | 'userActions' | 'store' | 'lastPlan'>;

/** What a read of the list needs. A narrow shape, so a development tool can read the same list without a whole stack. */
export interface SnapshotSource {
  db: Db;
  account: Account;
  store: Pick<MediaStore, 'listRows'>;
  userActions: Pick<BoundUserActions, 'listUnattributableOutbox'>;
  reconciler: Pick<ReconcilerHandle, 'last'>;
  lastPlan(): ReconcilePlan | null;
}

export const TITLE_MAX = 120;

export type Blocked = 'none' | 'quarantined' | 'purging';

export interface WorkListRow {
  id: string;
  /** The cached address, at most `TITLE_MAX` characters, or null when none is cached. */
  title: string | null;
  group: GroupKey;
  scheduledAt: number | null;
  pinned: boolean;
  /** Only a confirmed, healthy package of this account can be pinned. */
  canPin: boolean;
  /** A pinned package of this account that is not being removed can always be unpinned, even a quarantined one. */
  canUnpin: boolean;
  downloaded: boolean;
  lastError: RefreshErrorCode | null;
  /** Made on this device and not yet acknowledged by the server. */
  createdLocally: boolean;
  blocked: Blocked;
  /** Queued writes plus photos and clips not yet uploaded. */
  waiting: number;
  /** Failed queued writes plus stuck photos and clips. */
  needAttention: number;
  /** Queued writes of an inspection that left the list: on hold, never counted as waiting. */
  orphaned: number;
  /** A person may remove it from the device: it is quarantined, the latest suspicious answer names it, or it was never sent. */
  removable: boolean;
  /** Made on this device, not acknowledged by the server, and no create is queued for it any more (in any state, for any account). */
  neverSent: boolean;
  /** The removal rests on the latest suspicious answer rather than on a quarantine. */
  namedByPlan: boolean;
}

export interface FailedOutboxItem {
  key: string;
  op: string;
  inspectionId: string | null;
  error: OutboxErrorCode | null;
  bytes: number;
  /** The write that makes the inspection on the server. */
  isCreate: boolean;
}

export interface FailedMediaItem {
  pendingId: string;
  inspectionId: string;
  kind: string;
}

export interface RepairItem extends Omit<UnattributableRow, 'lastError'> {
  lastError: OutboxErrorCode | null;
}

export interface WorkListSnapshot {
  rows: WorkListRow[];
  /** The newest time any package was downloaded, or null. */
  updatedAt: number | null;
  failedOutbox: FailedOutboxItem[];
  failedMedia: FailedMediaItem[];
  repair: {
    rows: RepairItem[];
    /** Queued changes of other accounts: counted, never listed. */
    foreign: number;
    /** Stuck photos and clips whose inspection has no package on this device: listed, discardable, never retried. */
    orphanMedia: FailedMediaItem[];
    /** Stuck photos and clips of another account's inspections (or of nobody's): counted, never listed. */
    foreignMedia: number;
  };
  /** The company name for the responsibility wording, or null. */
  company: string | null;
  reconcile: ReconcileOutcome;
}

export type TitleMemo = Map<string, { fetchedAt: number; title: string | null }>;

function isOutboxErrorCode(value: unknown): value is OutboxErrorCode {
  return typeof value === 'string' && (OUTBOX_ERROR_CODES as readonly string[]).includes(value);
}

function truncate(text: string): string {
  const letters = Array.from(text);
  return letters.length > TITLE_MAX ? `${letters.slice(0, TITLE_MAX - 1).join('')}…` : text;
}

/** The address out of a cached `/api/inspections/{id}` body, or null for anything that is not the expected shape. */
function addressOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) return null;
    const data = parsed.data;
    if (typeof data !== 'object' || data === null || !('inspection' in data)) return null;
    const inspection = data.inspection;
    if (typeof inspection !== 'object' || inspection === null || !('propertyAddress' in inspection)) return null;
    const address = inspection.propertyAddress;
    if (typeof address !== 'string') return null;
    const clean = stripBidi(address).trim();
    return clean.length === 0 ? null : truncate(clean);
  } catch {
    return null;
  }
}

/**
 * Titles of the cached inspection rows, in at most TWO statements whatever the number of inspections: the fetch times of
 * every cached row, then (only when one of them is new or changed since `memo` saw it) the bodies, all in one query. A body is
 * parsed again only when its fetch time changed.
 */
async function readTitles(stack: SnapshotSource, memo: TitleMemo): Promise<Map<string, string | null>> {
  const key = accountKey(stack.account);
  const stamps = await stack.db.query<{ package_id: string; fetched_at: number }>("SELECT package_id, fetched_at FROM resource_cache WHERE account_key = ? AND key = '/api/inspections/' || package_id", [key]);
  const stale = stamps.some((stamp) => memo.get(stamp.package_id)?.fetchedAt !== stamp.fetched_at);
  const bodies = new Map<string, string>();
  if (stale) {
    const rows = await stack.db.query<{ package_id: string; body: string }>("SELECT package_id, body FROM resource_cache WHERE account_key = ? AND key = '/api/inspections/' || package_id", [key]);
    for (const row of rows) bodies.set(row.package_id, row.body);
  }
  const titles = new Map<string, string | null>();
  for (const stamp of stamps) {
    const known = memo.get(stamp.package_id);
    if (known !== undefined && known.fetchedAt === stamp.fetched_at) {
      titles.set(stamp.package_id, known.title);
      continue;
    }
    const body = bodies.get(stamp.package_id);
    const title = body === undefined ? null : addressOf(body);
    memo.set(stamp.package_id, { fetchedAt: stamp.fetched_at, title });
    titles.set(stamp.package_id, title);
  }
  return titles;
}

interface MediaCounts {
  waiting: number;
  failed: number;
}

async function readMediaCounts(stack: SnapshotSource): Promise<Map<string, MediaCounts>> {
  const rows = await stack.db.query<{ inspection_id: string; state: string; n: number }>('SELECT inspection_id, state, COUNT(*) AS n FROM media GROUP BY inspection_id, state');
  const out = new Map<string, MediaCounts>();
  for (const row of rows) {
    const counts = out.get(row.inspection_id) ?? { waiting: 0, failed: 0 };
    if (row.state === 'pending' || row.state === 'uploading') counts.waiting += Number(row.n);
    else if (row.state === 'failed') counts.failed += Number(row.n);
    out.set(row.inspection_id, counts);
  }
  return out;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** By scheduled time ascending (no date last), then by the title shown, then by id, so the order never depends on read order. */
function byTime(a: WorkListRow, b: WorkListRow): number {
  const at = Number.isFinite(a.scheduledAt) ? (a.scheduledAt as number) : Number.MAX_SAFE_INTEGER;
  const bt = Number.isFinite(b.scheduledAt) ? (b.scheduledAt as number) : Number.MAX_SAFE_INTEGER;
  return at - bt || compare(shortTitle(a), shortTitle(b)) || compare(a.id, b.id);
}

/** The inspections that have a create queued, in any state, for any account: such a package is still on its way to the server. */
async function readCreateTargets(db: Db): Promise<Set<string>> {
  const ops = DEFAULT_REGISTRY.filter((def) => def.createsInspection === true).map((def) => def.op);
  if (ops.length === 0) return new Set();
  const rows = await db.query<{ inspection_id: string | null }>(`SELECT DISTINCT inspection_id FROM outbox WHERE op IN (${ops.map(() => '?').join(', ')})`, ops);
  return new Set(rows.flatMap((r) => (r.inspection_id === null ? [] : [r.inspection_id])));
}

function isCreateOp(op: string): boolean {
  return DEFAULT_REGISTRY.some((def) => def.createsInspection === true && def.op === op);
}

/**
 * Everything the screen shows, read from the database (and the stack's own latest outcome) at one moment. Nothing is
 * remembered between calls except the parsed titles, which are keyed by the time the cached row was fetched.
 */
export async function readWorkListSnapshot(stack: SnapshotSource, now: number, memo: TitleMemo = new Map()): Promise<WorkListSnapshot> {
  const { db, account } = stack;
  const states = new Map((await readPackageStates(db, account)).map((s) => [s.inspectionId, s]));
  const packages = await readPackageRows(db);
  const titles = await readTitles(stack, memo);
  const outbox = await outboxCountsByInspection(db, { account });
  const media = await readMediaCounts(stack);
  const creates = await readCreateTargets(db);
  const plan: ReconcilePlan | null = stack.lastPlan();
  const planFresh = plan !== null && !planIsStale(plan, now);

  const rows: WorkListRow[] = [];
  for (const pkg of packages.values()) {
    if (!sameAccount(account, pkg.tenant_id, pkg.user_id)) continue;
    const state = states.get(pkg.inspection_id);
    const counts = outbox[pkg.inspection_id];
    const photos = media.get(pkg.inspection_id);
    const blocked: Blocked = Number(pkg.purging) !== 0 ? 'purging' : pkg.quarantine_source !== null ? 'quarantined' : 'none';
    const confirmed = Number(pkg.server_confirmed) === 1;
    const scheduledAt = pkg.scheduled_at === null ? null : Number(pkg.scheduled_at);
    const namedByPlan = blocked === 'none' && plan !== null && planFresh && namesMassSuspicious(plan, pkg.inspection_id, account);
    const neverSent = blocked === 'none' && !confirmed && !creates.has(pkg.inspection_id);
    rows.push({
      id: pkg.inspection_id,
      title: titles.get(pkg.inspection_id) ?? null,
      group: groupOf(scheduledAt, now),
      scheduledAt,
      pinned: Number(pkg.pinned) === 1,
      canPin: confirmed && blocked === 'none',
      canUnpin: Number(pkg.pinned) === 1 && blocked !== 'purging',
      downloaded: (state?.cachedResources ?? 0) > 0,
      lastError: state?.lastError ?? null,
      createdLocally: !confirmed,
      blocked,
      // On a quarantined inspection nothing is sent any more. Its queued writes are all "on hold" (the orphaned ones, and a
      // write that is still pending, such as one that was held back or arrived after the reconcile), so they are not counted
      // as waiting to upload; only photos and clips are, because they stay on the device, still unsent. Counting both under
      // "waiting" before and only the writes after is what made two items read as one.
      waiting: (blocked === 'quarantined' ? 0 : (counts?.pending ?? 0)) + (photos?.waiting ?? 0),
      needAttention: (counts?.failed ?? 0) + (photos?.failed ?? 0),
      orphaned: (counts?.orphaned ?? 0) + (blocked === 'quarantined' ? (counts?.pending ?? 0) : 0),
      removable: blocked === 'quarantined' || namedByPlan || neverSent,
      neverSent,
      namedByPlan,
    });
  }
  rows.sort(byTime);

  const repairList = await stack.userActions.listUnattributableOutbox();
  const repairKeys = new Set(repairList.rows.map((r) => r.idempotencyKey));
  const failedOutbox: FailedOutboxItem[] = [];
  const encoder = new TextEncoder();
  for (const row of await listOutbox(db, { account, states: ['failed'] })) {
    if (repairKeys.has(row.idempotencyKey)) continue;
    failedOutbox.push({ key: row.idempotencyKey, op: row.op, inspectionId: isLocalId(row.inspectionId) ? row.inspectionId : null, error: isOutboxErrorCode(row.lastError) ? row.lastError : null, bytes: encoder.encode(row.payload).byteLength, isCreate: isCreateOp(row.op) });
  }
  // A stuck photo is shown, and may be retried, only when its package is this account's (tenant AND user). One with no package
  // at all is an orphan (discardable, never retried); anyone else's is only counted.
  const failedMedia: FailedMediaItem[] = [];
  const orphanMedia: FailedMediaItem[] = [];
  let foreignMedia = 0;
  for (const m of await stack.store.listRows({ states: ['failed'] })) {
    const item: FailedMediaItem = { pendingId: m.pendingId, inspectionId: m.inspectionId, kind: m.kind };
    const owner = packages.get(m.inspectionId);
    if (owner === undefined) orphanMedia.push(item);
    else if (sameAccount(account, owner.tenant_id, owner.user_id)) failedMedia.push(item);
    else foreignMedia += 1;
  }

  let updatedAt: number | null = null;
  for (const state of states.values()) if (state.lastRefreshedAt !== null && (updatedAt === null || state.lastRefreshedAt > updatedAt)) updatedAt = state.lastRefreshedAt;

  return {
    rows,
    updatedAt,
    failedOutbox,
    failedMedia,
    repair: { rows: repairList.rows.map((r) => ({ ...r, lastError: isOutboxErrorCode(r.lastError) ? r.lastError : null })), foreign: repairList.foreign, orphanMedia, foreignMedia },
    company: await loadTenantName(db),
    reconcile: stack.reconciler.last,
  };
}

export type ModelState = { phase: 'loading'; snapshot: null } | { phase: 'error'; snapshot: null } | { phase: 'ready'; snapshot: WorkListSnapshot };

export interface WorkListModel {
  state: ModelState;
  /** Reads again. The newest read wins; an older one that finishes later is dropped. */
  reload(): Promise<void>;
  /** Forgets an error or the data and reads from scratch, showing the loading state. */
  retry(): Promise<void>;
}

export interface ModelOptions {
  now(): number;
  /** The interval of the refresh while the page is visible, in ms. 0 turns the interval off; events still refresh. */
  pollMs: number;
}

/**
 * Reads the work list from the stack and keeps it current. It reads on mount; when the stack's status changes; when the
 * page comes back to the front; after anything the screen itself does (through `reload`); and, because the reconciler,
 * the replayer and the uploader publish no change signal, on a bounded interval while the page is visible (a hidden page
 * reads nothing). A read that fails after data was shown keeps the data on screen.
 */
export function useWorkListModel(stack: WorkListStack, options: ModelOptions): WorkListModel {
  const [state, setState] = useState<ModelState>({ phase: 'loading', snapshot: null });
  const newest = useRef(0);
  const alive = useRef(true);
  const memo = useRef<TitleMemo>(new Map());
  const clock = useRef(options.now);
  clock.current = options.now;

  const reload = useCallback(async (): Promise<void> => {
    newest.current += 1;
    const mine = newest.current;
    const startedAt = performance.now();
    try {
      const snapshot = await readWorkListSnapshot(stack, clock.current(), memo.current);
      appTimings.record('snapshot_ms', performance.now() - startedAt);
      if (alive.current && mine === newest.current) setState({ phase: 'ready', snapshot });
    } catch {
      if (alive.current && mine === newest.current) setState((current) => (current.snapshot === null ? { phase: 'error', snapshot: null } : current));
    }
  }, [stack]);

  const retry = useCallback(async (): Promise<void> => {
    setState({ phase: 'loading', snapshot: null });
    await reload();
  }, [reload]);

  // The first snapshot (or the first failure) is on screen: the stack may begin its start sequence, which would otherwise have
  // queued behind or ahead of these reads on the one database connection. Idempotent on the stack's side.
  const phase = state.phase;
  useEffect(() => {
    if (phase !== 'loading') stack.markListPainted();
  }, [phase, stack]);

  useEffect(() => {
    alive.current = true;
    void reload();
    const off = stack.status.subscribe(() => {
      void reload();
    });
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer =
      options.pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === 'visible') void reload();
          }, options.pollMs)
        : null;
    return () => {
      alive.current = false;
      off();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== null) clearInterval(timer);
    };
  }, [stack, reload, options.pollMs]);

  return { state, reload, retry };
}
