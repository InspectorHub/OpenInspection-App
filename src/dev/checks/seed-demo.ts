import * as Y from 'yjs';
import { loadIdentity } from '../../auth/server-config';
import { resultsDocName } from '../../collab/connector';
import { MAX_UPLOAD_ATTEMPTS } from '../../media/native-uploader';
import { accountKey } from '../../offline/outbox';
import type { Db } from '../../platform/db';
import { fail, guarded, needsSignIn, pass, type CheckResult, type ExtraDef } from './types';

/**
 * Development only. Puts a few packages, queued writes and photos on the device so every state of the work list can be
 * looked at on an emulator. Everything it writes is named `diag-...` and `Remove demo data` takes exactly those away.
 *
 * Caution for whoever looks: these are real rows to the app, and the server has never heard of them. Waiting writes are
 * held back for a year so the replayer leaves them be, and stuck photos are marked as given up so the uploader does
 * too; but the next check of the server's list quarantines or removes the inspections it cannot find. Look with the
 * network off, or accept that the list changes after "Check now".
 */

const PREFIX = 'diag-';
const DAY_MS = 86_400_000;
const HOLD_MS = 365 * DAY_MS;

/** The item the defect photos below belong to, and the one defect that DOES exist in the demo results document. */
const DEMO_FINDING_KEY = '_default:s1:i1';
const DEMO_ITEM_ID = 'i1';
const DEMO_PRESENT_DEFECT = 'diag-defect-present';
/** The inspection whose stored results document the seed writes, and the defect the unattached photo names (it is not in that document). */
const DEMO_DOC_INSPECTION = 'diag-today';
const DEMO_ABSENT_DEFECT = 'diag-defect-removed';

const seedDef = { id: 'seed-demo', title: '[diag] seed-demo: demo inspections, queued changes and photos for the work list' };
const clearDef = { id: 'seed-demo-clear', title: '[diag] seed-demo-clear: remove the demo rows' };

interface Demo {
  id: string;
  address: string | null;
  /** Days from today; null for no date. */
  day: number | null;
  pinned?: boolean;
  downloaded?: boolean;
  confirmed?: boolean;
  quarantined?: boolean;
  purging?: boolean;
  refreshError?: string;
}

const DEMO: readonly Demo[] = [
  { id: 'diag-today', address: '12 Oak Street (demo)', day: 0, downloaded: true },
  { id: 'diag-pinned', address: '48 Harbour Road (demo)', day: 0, downloaded: true, pinned: true },
  { id: 'diag-waiting', address: '7 Mill Lane (demo)', day: 1, downloaded: true },
  { id: 'diag-failed', address: '301 Birch Court (demo)', day: 3, downloaded: true },
  { id: 'diag-refresh-error', address: null, day: 4, refreshError: 'rate_limited' },
  { id: 'diag-local', address: '5 Cedar Walk (demo, made on this device)', day: null, confirmed: false },
  { id: 'diag-earlier', address: '90 Quarry Street (demo)', day: -2, downloaded: true },
  { id: 'diag-quarantined', address: '22 Elm Grove (demo)', day: 0, downloaded: true, quarantined: true },
  { id: 'diag-quarantined-pinned', address: '3 Willow Mews (demo)', day: 1, downloaded: true, quarantined: true, pinned: true },
  { id: 'diag-removing', address: '16 Ash Close (demo)', day: 2, downloaded: true, purging: true },
];

function localNoon(now: number, day: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, 15, 0, 0).getTime();
}

async function clear(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM outbox WHERE substr(idempotency_key, 1, 5) = ?', [PREFIX]);
    await tx.run('DELETE FROM media WHERE substr(pending_id, 1, 5) = ?', [PREFIX]);
    await tx.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [resultsDocName(DEMO_DOC_INSPECTION)]);
    await tx.run('DELETE FROM resource_cache WHERE substr(package_id, 1, 5) = ?', [PREFIX]);
    await tx.run('DELETE FROM work_package WHERE substr(inspection_id, 1, 5) = ?', [PREFIX]);
  });
}

export { clear as clearDemo };

/**
 * A results document with one item holding a canned defect, as the editor shapes it. A photo naming any other defect finds
 * the document but not its defect, so the document step answers `missing` rather than failing.
 */
function demoResultsUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const defect = new Y.Map<unknown>();
  defect.set('cannedId', DEMO_PRESENT_DEFECT);
  defect.set('included', true);
  const canned = new Y.Array<unknown>();
  canned.push([defect]);
  const custom = new Y.Array<unknown>();
  const group = (list: Y.Array<unknown>): Y.Map<unknown> => {
    const map = new Y.Map<unknown>();
    map.set('defects', list);
    return map;
  };
  const item = new Y.Map<unknown>();
  item.set('tabs', group(canned));
  item.set('customComments', group(custom));
  item.set('photos', new Y.Array<unknown>());
  doc.getMap<unknown>('results').set(DEMO_FINDING_KEY, item);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

async function seed(db: Db, now: number): Promise<number> {
  const identity = await loadIdentity(db);
  if (identity === null) return -1;
  const account = { tenantId: identity.tenantId, userId: identity.userId };
  const key = accountKey(account);
  await clear(db);
  await db.transaction(async (tx) => {
    for (const demo of DEMO) {
      await tx.run(
        'INSERT INTO work_package (inspection_id, refreshed_at, pinned, scheduled_at, server_confirmed, tenant_id, user_id, purging, quarantine_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [demo.id, demo.downloaded === true ? now - 5 * 60_000 : 0, demo.pinned === true ? 1 : 0, demo.day === null ? null : localNoon(now, demo.day), demo.confirmed === false ? 0 : 1, account.tenantId, account.userId, demo.purging === true ? 2 : 0, demo.quarantined === true ? 'reconcile_missing' : null],
      );
      if (demo.downloaded === true) {
        const body = JSON.stringify({ success: true, data: { inspection: { id: demo.id, ...(demo.address === null ? {} : { propertyAddress: demo.address }) } } });
        await tx.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [key, `/api/inspections/${demo.id}`, body, now, demo.id]);
      }
      if (demo.refreshError !== undefined) {
        await tx.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [key, `$refresh_error:${demo.id}`, demo.refreshError, now, demo.id]);
      }
    }
    const top = (await tx.query<{ n: number | null }>('SELECT MAX(seq) AS n FROM outbox'))[0]?.n ?? 0;
    let seq = top;
    const queue = async (name: string, inspectionId: string | null, state: 'pending' | 'failed' | 'orphaned', error: string | null, payload: string): Promise<void> => {
      seq += 1;
      await tx.run(
        'INSERT INTO outbox (idempotency_key, seq, op, payload, state, last_error, created_at, inspection_id, tenant_id, user_id, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${PREFIX}${name}`, seq, 'inspection.update', payload, state, error, now, inspectionId, account.tenantId, account.userId, state === 'pending' ? now + HOLD_MS : null],
      );
    };
    await queue('waiting-1', 'diag-waiting', 'pending', null, '{"note":"demo"}');
    await queue('waiting-2', 'diag-waiting', 'pending', null, '{"note":"demo"}');
    await queue('failed-1', 'diag-failed', 'failed', 'validation_failed', '{"note":"demo change the server refused"}');
    await queue('orphan-1', 'diag-quarantined', 'orphaned', 'target_gone', '{"note":"demo"}');
    await queue('orphan-2', 'diag-quarantined', 'orphaned', 'target_gone', '{"note":"demo"}');
    await queue('repair-1', null, 'failed', 'rejected', '{"client":"Demo Client","note":"a change that names no inspection"}');
    const media = async (name: string, inspectionId: string): Promise<void> => {
      await tx.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [`${PREFIX}${name}`, inspectionId, 'photo', `media/${PREFIX}${name}.jpg`, 'image/jpeg', '{}', 'failed', MAX_UPLOAD_ATTEMPTS, now]);
    };
    await media('photo-failed', 'diag-failed');
    await media('photo-quarantined', 'diag-quarantined');
    const defectMeta = (customId: string, defectKind: 'canned' | 'custom'): string => JSON.stringify({ targetType: 'defect', findingKey: DEMO_FINDING_KEY, itemId: DEMO_ITEM_ID, customId, defectKind });
    const defectMedia = async (name: string, inspectionId: string, meta: string, state: 'failed' | 'uploaded', uploadedKey: string | null): Promise<void> => {
      await tx.run(
        'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, uploaded_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${PREFIX}${name}`, inspectionId, 'photo', `media/${PREFIX}${name}.jpg`, 'image/jpeg', meta, state, state === 'failed' ? MAX_UPLOAD_ATTEMPTS : 0, uploadedKey, now],
      );
    };
    // A stuck photo of a defect row has no entry in the document, so the work list offers "Discard photo" for it at any time.
    await defectMedia('photo-defect-canned', 'diag-failed', defectMeta('diag-defect-canned', 'canned'), 'failed', null);
    await defectMedia('photo-defect-custom', 'diag-failed', defectMeta('diag-defect-custom', 'custom'), 'failed', null);
    // On the server but named by no defect of the stored document: the reconciler's document step answers `missing`.
    const unattachedName = 'photo-unattached';
    await defectMedia(unattachedName, DEMO_DOC_INSPECTION, defectMeta(DEMO_ABSENT_DEFECT, 'custom'), 'uploaded', `${account.tenantId}/inspections/${DEMO_DOC_INSPECTION}/photos/${PREFIX}${unattachedName}.jpg`);
    await tx.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName(DEMO_DOC_INSPECTION), demoResultsUpdate()]);
  });
  return DEMO.length;
}

export const seedDemo: ExtraDef = {
  ...seedDef,
  parent: 'db-tx',
  label: 'Seed demo data',
  hint: 'Adds demo inspections, queued changes, stuck photos (item and defect) and one uploaded photo that no defect holds (all named diag-) so every state of the work list can be seen. Look with the network off.',
  run: (ctx): Promise<CheckResult> =>
    guarded(seedDef, async () => {
      if (ctx.origin === null) return needsSignIn(seedDef);
      const count = await seed(ctx.services.db, ctx.services.clock.now());
      if (count < 0) return needsSignIn(seedDef);
      return pass(seedDef, `inspections=${String(count)} queued=6 photos=5 (4 failed, 1 uploaded)`);
    }),
};

export const seedDemoClear: ExtraDef = {
  ...clearDef,
  parent: 'db-tx',
  label: 'Remove demo data',
  hint: 'Removes exactly the rows named diag-.',
  run: (ctx): Promise<CheckResult> =>
    guarded(clearDef, async () => {
      await clear(ctx.services.db);
      const left = await ctx.services.db.query<{ n: number }>('SELECT (SELECT COUNT(*) FROM work_package WHERE substr(inspection_id, 1, 5) = ?) + (SELECT COUNT(*) FROM outbox WHERE substr(idempotency_key, 1, 5) = ?) AS n', [PREFIX, PREFIX]);
      const n = Number(left[0]?.n ?? -1);
      return n === 0 ? pass(clearDef, 'left=0') : fail(clearDef, `left=${String(n)}`);
    }),
};
