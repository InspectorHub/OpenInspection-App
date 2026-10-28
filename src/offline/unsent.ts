import { docIsCovered } from '../collab/sync-proof';
import type { Db } from '../platform/db';
import { MEDIA_STATES } from '../platform/schema';
import { assertAccount, sameAccount, type Account } from './outbox';
import { ALLOWED_GLOBAL_OPS, isLocalId } from './registry';

/**
 * The one answer to "would removing this inspection from the device lose work that has not reached the server?".
 *
 * Every check errs the same way: anything that cannot be shown to be safe counts as unsent. The reasons are a fixed
 * vocabulary, never text from a row, a payload or the server.
 *
 *  - `outbox_*`: a queued write for the inspection in ANY state. Pending ones wait for a send, failed ones wait for a
 *    person, orphaned ones were parked after the inspection vanished; all three are the person's work. Rows of every
 *    account count, not only the signed-in one. A state this code does not know is `outbox_other` and counts too.
 *  - `outbox_unattributable`: a queued write that names no usable inspection (NULL, empty, outside the id charset, a
 *    reserved route segment) belongs to an inspection nobody can tell, so it could belong to THIS one. The answer is then
 *    `unknown` for every inspection; the caller must refuse the whole reconcile. The registry refuses to enqueue such a
 *    row, so this is a guard against a bug or an older build, and the column alone decides: a payload that appears to
 *    name an inspection is never used to rescue the row.
 *  - `media_*`: every row of the `media` table counts, whatever its state, because the row is the only thing that
 *    still points at a photo or clip. The reconciler deletes a row only after the inspection's document holds the
 *    server key (`finish` in `src/media/reconcile.ts`: document first, then `store.delete`). So an `uploaded` row means
 *    the bytes are on the server but the document still holds a placeholder nothing resolved yet, and removing the
 *    inspection now would lose the person's placement of that photo; and a row the reconciler could not place
 *    (`missing`) stays for good. There is no state of a surviving row that is safe, so the allow-list of safe states is
 *    empty. A state outside `MEDIA_STATES` is `media_unknown_state`.
 *  - `tags_not_on_server`: a tag a person put on an item, or took off one, that the server has not been told about yet
 *    (`item_tags` rows that are not `synced`). They are not in the queue (see `item-tags-store.ts`), so this is the only
 *    place that counts them. Rows of every account count.
 *  - `ydoc_not_on_server`: the device stores updates of the results document and `docIsCovered` cannot show that the
 *    server holds all of them. A document with no stored update, or one whose stored content is empty, has nothing to
 *    lose.
 *  - `created_locally`: the inspection was created on this device and the server has not acknowledged the create.
 *  - `package_owner_mismatch`: the package row belongs to another account or to nobody, so this account cannot vouch for it.
 *
 * All reads run in ONE transaction. The `Db` runs a transaction without anything else interleaving, so the six
 * facts (queue, media, tags, document, package, unattributable rows) are one snapshot: a write that arrives during the
 * call is applied after it, never between two of its reads. The Yjs coverage check is inside the transaction for the
 * same reason; it loads at most 5 MiB into a scratch document and the transaction holds the connection for that time.
 */

export const UNSENT_REASONS = [
  'outbox_unattributable',
  'outbox_pending',
  'outbox_failed',
  'outbox_orphaned',
  'outbox_other',
  'media_not_uploaded',
  'media_uploaded_unresolved',
  'media_unknown_state',
  'tags_not_on_server',
  'ydoc_not_on_server',
  'created_locally',
  'package_owner_mismatch',
] as const;
export type UnsentReason = (typeof UNSENT_REASONS)[number];

export interface UnsentCounts {
  outbox: { pending: number; failed: number; orphaned: number; other: number };
  media: { notUploaded: number; uploaded: number; unknownState: number };
  /** Tag changes on this inspection's items that the server has not been told about. */
  tags: number;
  ydocRows: number;
  /** Null when there is no stored update to ask about. */
  ydocCovered: boolean | null;
  createdLocally: boolean;
  /** Queued writes (of any inspection) that name no usable inspection. */
  unattributableOutbox: number;
}

export interface UnsentResult {
  /** True when anything at all is unsent, and always true when `unknown`. */
  unsent: boolean;
  /** The queue holds a write that cannot be attributed to an inspection: no inspection can be called safe. */
  unknown: boolean;
  reasons: UnsentReason[];
  counts: UnsentCounts;
}

function emptyCounts(): UnsentCounts {
  return {
    outbox: { pending: 0, failed: 0, orphaned: 0, other: 0 },
    media: { notUploaded: 0, uploaded: 0, unknownState: 0 },
    tags: 0,
    ydocRows: 0,
    ydocCovered: null,
    createdLocally: false,
    unattributableOutbox: 0,
  };
}

/** Queued writes that name no usable inspection, apart from an op that is declared to belong to none. */
export async function unattributableOutboxRows(db: Db): Promise<number> {
  const groups = await db.query<{ inspection_id: string | null; op: string; n: number }>('SELECT inspection_id, op, COUNT(*) AS n FROM outbox GROUP BY inspection_id, op');
  let total = 0;
  for (const group of groups) {
    if (group.inspection_id === null && ALLOWED_GLOBAL_OPS.includes(group.op)) continue;
    if (!isLocalId(group.inspection_id)) total += Number(group.n);
  }
  return total;
}

async function read(tx: Db, inspectionId: string, account: Account): Promise<UnsentResult> {
  const counts = emptyCounts();
  const reasons = new Set<UnsentReason>();

  counts.unattributableOutbox = await unattributableOutboxRows(tx);
  if (counts.unattributableOutbox > 0) reasons.add('outbox_unattributable');

  const queued = await tx.query<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM outbox WHERE inspection_id = ? GROUP BY state', [inspectionId]);
  for (const row of queued) {
    const n = Number(row.n);
    if (row.state === 'pending') counts.outbox.pending += n;
    else if (row.state === 'failed') counts.outbox.failed += n;
    else if (row.state === 'orphaned') counts.outbox.orphaned += n;
    else counts.outbox.other += n;
  }
  if (counts.outbox.pending > 0) reasons.add('outbox_pending');
  if (counts.outbox.failed > 0) reasons.add('outbox_failed');
  if (counts.outbox.orphaned > 0) reasons.add('outbox_orphaned');
  if (counts.outbox.other > 0) reasons.add('outbox_other');

  const stored = await tx.query<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM media WHERE inspection_id = ? GROUP BY state', [inspectionId]);
  for (const row of stored) {
    const n = Number(row.n);
    if (row.state === 'uploaded') counts.media.uploaded += n;
    else if ((MEDIA_STATES as readonly string[]).includes(row.state)) counts.media.notUploaded += n;
    else counts.media.unknownState += n;
  }
  if (counts.media.notUploaded > 0) reasons.add('media_not_uploaded');
  if (counts.media.uploaded > 0) reasons.add('media_uploaded_unresolved');
  if (counts.media.unknownState > 0) reasons.add('media_unknown_state');

  const tags = await tx.query<{ n: number }>("SELECT COUNT(*) AS n FROM item_tags WHERE inspection_id = ? AND state <> 'synced'", [inspectionId]);
  counts.tags = Number(tags[0]?.n ?? 0);
  if (counts.tags > 0) reasons.add('tags_not_on_server');

  const docName = `results-${inspectionId}`;
  const updates = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [docName]);
  counts.ydocRows = Number(updates[0]?.n ?? 0);
  if (counts.ydocRows > 0) {
    counts.ydocCovered = await docIsCovered(tx, docName);
    if (!counts.ydocCovered) reasons.add('ydoc_not_on_server');
  }

  const packages = await tx.query<{ server_confirmed: number; tenant_id: string | null; user_id: string | null }>('SELECT server_confirmed, tenant_id, user_id FROM work_package WHERE inspection_id = ?', [inspectionId]);
  const row = packages[0];
  if (row !== undefined) {
    counts.createdLocally = Number(row.server_confirmed) !== 1;
    if (counts.createdLocally) reasons.add('created_locally');
    if (!sameAccount(account, row.tenant_id, row.user_id)) reasons.add('package_owner_mismatch');
  }

  const unknown = counts.unattributableOutbox > 0;
  return { unsent: reasons.size > 0, unknown, reasons: UNSENT_REASONS.filter((reason) => reasons.has(reason)), counts };
}

/** Throws `RangeError` for an id that could not be an inspection id, and `OutboxError` for an unusable account. Only reads. */
export async function unsentData(db: Db, inspectionId: string, account: Account): Promise<UnsentResult> {
  if (!isLocalId(inspectionId)) throw new RangeError('Invalid inspection id');
  assertAccount(account);
  return db.transaction((tx) => read(tx, inspectionId, account));
}
