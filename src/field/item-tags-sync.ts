import type { Account } from '../offline/outbox';
import { accountKey } from '../offline/outbox';
import type { IsBlocked } from '../offline/blocked';
import type { Db } from '../platform/db';
import { apiPath, type Api } from './api-client';
import { isRec } from './commands-shared';
import { dropRejected, mergeFromServer, pendingTags, settleSent, type TagInfo, type TagMap, type TagRow } from './item-tags-store';

/**
 * Tells the server about tag changes made on the device, and reads what the server has.
 *
 * The rows are a set with a state (`item-tags-store.ts`), not a queue: each add or removal is idempotent and independent of
 * every other write, so a change the server will never take is dropped on its own and holds nothing back. That is the
 * difference from the outbox, whose one stuck head holds back its whole inspection and which would treat the 404 of a
 * tag deleted elsewhere as "the inspection is not visible" and wait on it for good.
 *
 * `Api.send` already refuses to contact the server when the device is offline, locked, signed out or the server is too old,
 * so those answers (`problem`) simply leave every row where it is.
 */

export interface ItemTagSyncDeps {
  api: Api;
  db: Db;
  account: Account;
  isOnline(): boolean;
  isBlocked: IsBlocked;
  now(): number;
  /** Called with how many changes the server refused for good in one flush (they have been undone on the device). */
  onRejected?(count: number): void;
}

export interface FlushResult {
  sent: number;
  rejected: number;
}

export interface ItemTagSync {
  /** Sends the changes the server has not heard yet: one inspection's, or (omitted) every inspection's of the account. */
  flush(inspectionId?: string): Promise<FlushResult>;
  /** Reads the server's tags for the inspection into the device without losing a change not sent yet. False when it could not. */
  pull(inspectionId: string): Promise<boolean>;
}

type Verdict = 'sent' | 'rejected' | 'later';

/** What the server's answer means for one row. Only the status picks the branch; no server text is kept. */
function verdictOf(outcome: Awaited<ReturnType<Api['send']>>): Verdict {
  // Nothing was sent, or the answer was lost: the row stays and is sent again (a repeat changes nothing).
  if (outcome.kind === 'problem') return 'later';
  const { status, json } = outcome;
  // A page that is not the server's (a captive portal answering 200) must never settle a change.
  if (status >= 200 && status < 300) return isRec(json) && json.success === true ? 'sent' : 'later';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'later';
  return 'rejected';
}

function parseTags(json: unknown): TagMap | null {
  if (!isRec(json) || json.success !== true || !isRec(json.data)) return null;
  const map: TagMap = {};
  for (const [itemId, list] of Object.entries(json.data)) {
    if (!Array.isArray(list)) continue;
    const tags: TagInfo[] = [];
    for (const entry of list) {
      if (!isRec(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
      tags.push({ id: entry.id, name: entry.name, ...(typeof entry.color === 'string' ? { color: entry.color } : {}) });
    }
    if (tags.length > 0) map[itemId] = tags;
  }
  return map;
}

export function createItemTagSync(deps: ItemTagSyncDeps): ItemTagSync {
  const account = accountKey(deps.account);
  /** One server round at a time: a flush and a pull never interleave, so a pull never reads before a send that preceded it has settled. */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };

  async function sendOne(row: TagRow): Promise<Verdict> {
    let path: string;
    try {
      path = row.state === 'add' ? apiPath(row.inspectionId, 'items', row.itemId, 'tags') : apiPath(row.inspectionId, 'items', row.itemId, 'tags', row.tagId);
    } catch {
      // A name that cannot be part of a path can never be sent.
      return 'rejected';
    }
    const outcome = await deps.api.send(row.state === 'add' ? { method: 'POST', path, json: { tagId: row.tagId } } : { method: 'DELETE', path });
    return verdictOf(outcome);
  }

  async function flushNow(inspectionId?: string): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, rejected: 0 };
    if (!deps.isOnline()) return result;
    for (const row of await pendingTags(deps.db, account, inspectionId)) {
      // A blocked inspection (being removed from the device) is not contacted, and its row is left as it is.
      if (await deps.isBlocked(row.inspectionId)) continue;
      const verdict = await sendOne(row);
      if (verdict === 'later') {
        // The same answer would come for the next row: stop here, and the next flush starts again.
        break;
      }
      if (verdict === 'sent') {
        await settleSent(deps.db, account, row);
        result.sent += 1;
      } else {
        await dropRejected(deps.db, account, row);
        result.rejected += 1;
      }
    }
    if (result.rejected > 0) deps.onRejected?.(result.rejected);
    return result;
  }

  async function pullNow(inspectionId: string): Promise<boolean> {
    if (!deps.isOnline() || (await deps.isBlocked(inspectionId))) return false;
    let path: string;
    try {
      path = apiPath(inspectionId, 'tags');
    } catch {
      return false;
    }
    const outcome = await deps.api.send({ method: 'GET', path });
    if (outcome.kind !== 'response' || outcome.status < 200 || outcome.status >= 300) return false;
    const tags = parseTags(outcome.json);
    if (tags === null) return false;
    await mergeFromServer(deps.db, account, inspectionId, tags, deps.now());
    return true;
  }

  return {
    flush: (inspectionId) => serial(() => flushNow(inspectionId)).catch(() => ({ sent: 0, rejected: 0 })),
    pull: (inspectionId) => serial(() => pullNow(inspectionId)).catch(() => false),
  };
}
