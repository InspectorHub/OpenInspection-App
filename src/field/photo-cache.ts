import type { PhotoSize } from '@inspectorhub/field-ui';
import type { TimerPort } from '../collab/timers';
import { PHOTO_CACHE_DIRECTORY } from '../media/sweep';
import { isCacheFilePath, purgePhotoCopies, sweepPhotoCacheOrphans } from '../offline/purge-photo-cache';
import { accountKey } from '../offline/outbox';
import type { Account } from '../offline/outbox';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { apiPath, type Api } from './api-client';
import { DEFAULT_PHOTO_CACHE_LIMITS, PHOTO_WIDTHS, sha256Hex, sniff, TYPE_OF, type Kind, type LocalCopyReader, type LocalPhotoCopy, type PhotoCacheLimits } from './photo-cache-support';
import type { NetworkFlag } from './network-flag';

/**
 * Copies of photos the server holds, kept on the device so the editor can show one whose file is no longer here. The
 * server's photo route needs the Bearer header, which an `<img src>` cannot send, so the bytes are fetched with the
 * session, written under `photo-cache/` and shown through the same local address a stored photo gets.
 *
 * Every copy here is a COPY. Evicting one loses nothing: the server has the photo. The cache never touches `media/`, the
 * `media` table or a photo that has not been sent, so the only copy of unsent work is never at risk from it.
 *
 * `lookup` is synchronous because `urls.photo` is. A miss answers null (the caller shows the placeholder) and queues one
 * download; when it lands the listeners hear it and the editor asks again. A photo that is still on the device (just
 * uploaded) is adopted from its own file without a request.
 */

export { PHOTO_CACHE_DIRECTORY };
export { DEFAULT_PHOTO_CACHE_LIMITS, PHOTO_WIDTHS };
export type { LocalCopyReader, LocalPhotoCopy, PhotoCacheLimits };

export interface PhotoCache {
  /** The device address of the copy, or null (a download is queued when online). */
  lookup(inspectionId: string, key: string, size: PhotoSize): string | null;
  /** Called after copies were added. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Reads what is stored for the inspection so its photos answer on the first render. Never rejects. */
  warm(inspectionId: string): Promise<void>;
  /**
   * Adopts the on-device files of these uploaded photos now (no request), so they answer even after those files are
   * deleted. Answers the keys it could not make a copy of (a format the web view cannot show, or too big), which the
   * caller may still show from their file. Keys left over when the time budget ends are adopted when asked for. Never rejects.
   */
  prime(inspectionId: string, keys: readonly string[]): Promise<string[]>;
  /** Removes cache files no row names (a crash between the file and its row). Answers how many went. Never rejects. */
  sweepOrphans(): Promise<number>;
  /** Stops: nothing more is asked, written or announced. In-flight downloads are dropped when they land. */
  dispose(): void;
  /** Forgets the copies of one inspection. */
  purgeInspection(inspectionId: string): Promise<void>;
}

export interface PhotoCacheDeps {
  db: Db;
  files: Pick<Files, 'write' | 'remove' | 'displayUrl' | 'exists' | 'list'>;
  api: Pick<Api, 'send'>;
  account: Account;
  network: Pick<NetworkFlag, 'isOnline' | 'onOnlineChange' | 'ready'>;
  clock: Clock;
  timers: TimerPort;
  /** The bytes of an uploaded photo whose file is still on this device, or null. */
  localCopy?: LocalCopyReader;
  onError?(error: unknown): void;
  limits?: Partial<PhotoCacheLimits>;
}

const NOTIFY_PAUSE_MS = 100;
const PRIME_BUDGET_MS = 3000;
const PRIME_CONCURRENCY = 3;
const TOUCH_EVERY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface Row {
  hash: string;
  inspection_id: string;
  key: string;
  size: PhotoSize;
  path: string;
  bytes: number;
}

/** Larger copies that can stand in for a smaller ask, in the order they are tried. */
const STANDS_IN: Record<PhotoSize, readonly PhotoSize[]> = { thumb: ['thumb', 'view', 'original'], view: ['view', 'original'], original: ['original'] };

export function createPhotoCache(deps: PhotoCacheDeps): PhotoCache {
  const limits: PhotoCacheLimits = { ...DEFAULT_PHOTO_CACHE_LIMITS, ...deps.limits };
  const account = accountKey(deps.account);
  const memo = new Map<string, { url: string; hash: string; touchedAt: number }>();
  const inflight = new Set<string>();
  const storing = new Map<string, Promise<void>>();
  const reportedTypes = new Set<string>();
  /** A copy is a short address; there is room for every row the cache may hold, so a visible photo is never pushed out. */
  const memoLimit = limits.maxEntries;
  const queue: Array<{ id: string; inspectionId: string; key: string; size: PhotoSize }> = [];
  const blockedUntil = new Map<string, number>();
  const waitingForNetwork = new Map<string, { inspectionId: string; key: string; size: PhotoSize }>();
  const listeners = new Set<(() => void)>();
  let active = 0;
  let closed = false;
  let notifyTimer: unknown = null;

  const report = (error: unknown): void => {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter changes nothing.
    }
  };
  const idOf = (inspectionId: string, key: string, size: PhotoSize): string => `${inspectionId}\n${key}\n${size}`;

  function notify(): void {
    if (closed || notifyTimer !== null) return;
    notifyTimer = deps.timers.setTimeout(() => {
      notifyTimer = null;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          report(error);
        }
      }
    }, NOTIFY_PAUSE_MS);
  }

  function remember(id: string, url: string, hash: string): void {
    memo.delete(id);
    if (memo.size >= memoLimit) {
      const oldest = memo.keys().next();
      if (!oldest.done) memo.delete(oldest.value);
    }
    memo.set(id, { url, hash, touchedAt: deps.clock.now() });
  }

  function answer(inspectionId: string, key: string, size: PhotoSize): string | null {
    for (const candidate of STANDS_IN[size]) {
      const hit = memo.get(idOf(inspectionId, key, candidate));
      if (hit === undefined) continue;
      const now = deps.clock.now();
      if (now - hit.touchedAt > TOUCH_EVERY_MS) {
        hit.touchedAt = now;
        deps.db.run('UPDATE photo_cache SET last_used_at = ? WHERE hash = ?', [now, hit.hash]).catch(report);
      }
      return hit.url;
    }
    return null;
  }

  async function adopt(row: Row, touch: boolean): Promise<boolean> {
    try {
      if (!(await deps.files.exists(row.path))) {
        await deps.db.run('DELETE FROM photo_cache WHERE hash = ?', [row.hash]);
        return false;
      }
      // A copy a session shows is a copy in use, whether or not it was downloaded in this session.
      if (touch) await deps.db.run('UPDATE photo_cache SET last_used_at = ? WHERE hash = ?', [deps.clock.now(), row.hash]);
      remember(idOf(row.inspection_id, row.key, row.size), await deps.files.displayUrl(row.path), row.hash);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function evict(keepHash: string): Promise<void> {
    const total = (await deps.db.query<{ bytes: number | null; n: number }>('SELECT sum(bytes) AS bytes, count(*) AS n FROM photo_cache WHERE account_key = ?', [account]))[0];
    let bytes = total?.bytes ?? 0;
    let count = total?.n ?? 0;
    if (bytes <= limits.maxBytes && count <= limits.maxEntries) return;
    const goalBytes = limits.maxBytes * 0.8;
    const goalCount = Math.floor(limits.maxEntries * 0.8);
    const oldest = await deps.db.query<Row>('SELECT hash, inspection_id, key, size, path, bytes FROM photo_cache WHERE account_key = ? ORDER BY last_used_at ASC', [account]);
    for (const row of oldest) {
      if (bytes <= goalBytes && count <= goalCount) break;
      if (row.hash === keepHash) continue;
      await deps.db.run('DELETE FROM photo_cache WHERE hash = ?', [row.hash]);
      memo.delete(idOf(row.inspection_id, row.key, row.size));
      if (isCacheFilePath(row.path)) await deps.files.remove(row.path).catch(report);
      bytes -= row.bytes;
      count -= 1;
    }
  }

  /** One writer per file: a second caller for the same copy waits for the first instead of writing the same path. */
  function store(inspectionId: string, key: string, size: PhotoSize, kind: Kind, bytes: Uint8Array, evictNow = true): Promise<void> {
    if (closed) return Promise.resolve();
    const id = idOf(inspectionId, key, size);
    const running = storing.get(id);
    if (running !== undefined) return running;
    const writing = storeNow(inspectionId, key, size, kind, bytes, evictNow).finally(() => storing.delete(id));
    storing.set(id, writing);
    return writing;
  }

  async function storeNow(inspectionId: string, key: string, size: PhotoSize, kind: Kind, bytes: Uint8Array, evictNow: boolean): Promise<void> {
    const hash = await sha256Hex(`${account}|${inspectionId}|${key}|${size}`);
    const path = `${PHOTO_CACHE_DIRECTORY}/${hash}.${kind}`;
    await deps.files.write(path, bytes);
    if (closed) {
      // Signed out or left the editor while this was in flight: it must not outlive the data it belongs to.
      await deps.files.remove(path).catch(report);
      return;
    }
    const now = deps.clock.now();
    await deps.db.run(
      'INSERT OR REPLACE INTO photo_cache (hash, account_key, inspection_id, key, size, path, bytes, content_type, last_used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [hash, account, inspectionId, key, size, path, bytes.byteLength, TYPE_OF[kind], now, now],
    );
    // The same copy under another extension (the server answered in another format this time) must not leave the old file.
    for (const other of Object.keys(TYPE_OF)) if (other !== kind) await deps.files.remove(`${PHOTO_CACHE_DIRECTORY}/${hash}.${other}`).catch(() => undefined);
    remember(idOf(inspectionId, key, size), await deps.files.displayUrl(path), hash);
    // The copy is stored and shown whatever happens to the housekeeping after it.
    if (evictNow) await evict(hash).catch(report);
    notify();
  }

  function block(id: string, ms: number): void {
    blockedUntil.set(id, deps.clock.now() + ms);
  }

  async function download(inspectionId: string, key: string, size: PhotoSize, id: string): Promise<void> {
    let path: string;
    try {
      path = apiPath(inspectionId, 'photo');
    } catch {
      return;
    }
    const outcome = await deps.api.send({
      method: 'GET',
      path,
      query: size === 'original' ? { key } : { key, w: String(PHOTO_WIDTHS[size]) },
      binary: true,
      maxBytes: limits.maxFileBytes,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (outcome.kind === 'problem') {
      // Nothing was stored. Being offline is retried when the network comes back; the rest after a pause.
      // Parked for the network only when the device really is offline; a timeout on a working link just waits out the pause.
      if (outcome.problem === 'offline' && !deps.network.isOnline()) waitingForNetwork.set(id, { inspectionId, key, size });
      block(id, limits.problemMs);
      return;
    }
    if (outcome.status === 403 || outcome.status === 404) return block(id, limits.notFoundMs);
    if (outcome.status !== 200) return block(id, outcome.status >= 500 || outcome.status === 429 ? Math.min(outcome.retryAfterMs ?? limits.serverErrorMs, 10 * 60_000) : limits.notFoundMs);
    const bytes = outcome.bytes ?? new Uint8Array();
    const declared = (outcome.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const kind = sniff(bytes);
    if (kind === null || declared !== TYPE_OF[kind] || bytes.byteLength > limits.maxFileBytes) {
      // Once per type, naming no photo: a HEIC original (or any format the web view cannot show) keeps the placeholder.
      const type = declared === '' ? 'unknown' : declared;
      if (!reportedTypes.has(type)) {
        reportedTypes.add(type);
        report(new Error(`photo-cache: not cached (type ${type}, ${String(bytes.byteLength)} bytes)`));
      }
      return block(id, limits.notFoundMs);
    }
    await store(inspectionId, key, size, kind, bytes);
  }

  async function run(task: { id: string; inspectionId: string; key: string; size: PhotoSize }): Promise<void> {
    const { id, inspectionId, key, size } = task;
    const hash = await sha256Hex(`${account}|${inspectionId}|${key}|${size}`);
    const stored = await deps.db.query<Row>('SELECT hash, inspection_id, key, size, path, bytes FROM photo_cache WHERE hash = ? AND account_key = ?', [hash, account]);
    if (stored[0] !== undefined && (await adopt(stored[0], true))) return notify();
    const local = await deps.localCopy?.(inspectionId, key);
    if (local !== undefined && local !== null) {
      const kind = sniff(local.bytes);
      if (kind !== null && local.bytes.byteLength <= limits.maxFileBytes) return store(inspectionId, key, 'original', kind, local.bytes);
    }
    // The flag reads the platform once at the start; until it has, "offline" only means "not known yet".
    await deps.network.ready;
    if (closed) return;
    if (!deps.network.isOnline()) {
      waitingForNetwork.set(id, { inspectionId, key, size });
      return;
    }
    await download(inspectionId, key, size, id);
  }

  function pump(): void {
    while (!closed && active < limits.concurrency) {
      const task = queue.shift();
      if (task === undefined) return;
      active += 1;
      run(task)
        .catch((error: unknown) => {
          report(error);
          block(task.id, limits.failureMs);
        })
        .finally(() => {
          active -= 1;
          inflight.delete(task.id);
          pump();
        });
    }
  }

  const stopNetwork = deps.network.onOnlineChange((online) => {
    if (closed || !online) return;
    const waiting = [...waitingForNetwork.entries()];
    waitingForNetwork.clear();
    for (const [id, task] of waiting) {
      blockedUntil.delete(id);
      if (inflight.has(id)) continue;
      inflight.add(id);
      queue.push({ id, ...task });
    }
    pump();
  });

  return {
    lookup(inspectionId, key, size) {
      const hit = answer(inspectionId, key, size);
      if (hit !== null) return hit;
      if (closed || !ID_PATTERN.test(inspectionId) || key === '') return null;
      const id = idOf(inspectionId, key, size);
      if (inflight.has(id) || waitingForNetwork.has(id)) return null;
      const until = blockedUntil.get(id);
      if (until !== undefined && deps.clock.now() < until) return null;
      inflight.add(id);
      queue.push({ id, inspectionId, key, size });
      pump();
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async warm(inspectionId) {
      try {
        const rows = await deps.db.query<Row>('SELECT hash, inspection_id, key, size, path, bytes FROM photo_cache WHERE account_key = ? AND inspection_id = ? ORDER BY last_used_at DESC LIMIT ?', [account, inspectionId, memoLimit]);
        for (const row of rows) await adopt(row, false);
        if (rows.length > 0) await deps.db.run('UPDATE photo_cache SET last_used_at = ? WHERE account_key = ? AND inspection_id = ?', [deps.clock.now(), account, inspectionId]);
      } catch (error) {
        report(error);
      }
    },
    async purgeInspection(inspectionId) {
      for (const id of [...memo.keys()]) if (id.startsWith(`${inspectionId}\n`)) memo.delete(id);
      await purgePhotoCopies(deps.db, deps.files, account, inspectionId);
    },
    async prime(inspectionId, keys) {
      const reader = deps.localCopy;
      const todo = keys.slice(0, memoLimit);
      if (reader === undefined) return [...todo];
      const uncached: string[] = [];
      try {
        const read = reader.open === undefined ? (key: string) => reader(inspectionId, key) : await reader.open(inspectionId);
        const started = deps.clock.now();
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const key = todo[next++];
            if (closed || key === undefined || deps.clock.now() - started > PRIME_BUDGET_MS) return;
            try {
              if (answer(inspectionId, key, 'original') !== null) continue;
              const local = await read(key);
              if (local === null) continue;
              const kind = sniff(local.bytes);
              if (kind === null || local.bytes.byteLength > limits.maxFileBytes) uncached.push(key);
              else await store(inspectionId, key, 'original', kind, local.bytes, false);
            } catch (error) {
              report(error);
              uncached.push(key);
            }
          }
        };
        await Promise.all(Array.from({ length: PRIME_CONCURRENCY }, worker));
        await evict('').catch(report);
      } catch (error) {
        report(error);
      }
      return uncached;
    },
    sweepOrphans: () => sweepPhotoCacheOrphans(deps.db, deps.files, deps.clock.now(), () => closed, report),
    dispose() {
      closed = true;
      queue.length = 0;
      waitingForNetwork.clear();
      listeners.clear();
      if (notifyTimer !== null) deps.timers.clearTimeout(notifyTimer);
      notifyTimer = null;
      stopNetwork();
    },
  };
}
