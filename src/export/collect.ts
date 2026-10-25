import { resultsDocName } from '../collab/connector';
import { docIsCovered } from '../collab/sync-proof';
import type { Db } from '../platform/db';
import { DEFAULT_REGISTRY, findCommand, type Payload } from '../offline/registry';
import {
  IDEMPOTENCY_KEY_PATTERN,
  PACKAGE_ID_PATTERN,
  UNKNOWN_DEVICE_ID,
  UNKNOWN_REPORT_ID,
  isPackagePhotoType,
  type OutboxJsonEntry,
  type PackagePhotoType,
} from './format';

/** Who is exporting. Both parts come from the stored, verified identity of the device. */
export interface ExportIdentity {
  tenantId: string;
  userId: string;
}

export interface CollectOptions {
  /** The person chose to take inspections the server no longer lists (quarantined) along. */
  includeQuarantined: boolean;
  /** Restricts the export to these inspections. */
  only?: readonly string[] | undefined;
}

export interface PlannedInspection {
  id: string;
  reportId: string;
  /** The device knows the server's report id (the placeholder is NOT used). */
  reportIdKnown: boolean;
  quarantined: boolean;
}

export interface PlannedPhoto {
  pendingId: string;
  inspectionId: string;
  contentType: PackagePhotoType;
  /** Relative to the app's storage; read file by file. */
  path: string;
}

/** What the format cannot carry or the exporter chose to leave, so the person can be told. Counts only. */
export interface OmittedCounts {
  /** Recorded clips of exported inspections: the package has no place for video. */
  videos: number;
  /** Crops and annotations of a photo of exported inspections: the package indexes a photo by id and type only. */
  photoEdits: number;
  /** Queued writes of exported inspections that could not be written in the format (unknown command, damaged payload). */
  skippedWrites: number;
  /** Writes of exported inspections the server refused. They wait for a person and stay on the device. */
  failedWrites: number;
  /** Inspections left out because their creation was refused or cannot be written: the importer would refuse the whole package. */
  creationRefused: number;
  /** Inspections with stored work that the device can PROVE the server already holds, left out. */
  alreadyOnServer: number;
  /** Exported inspections the importer may refuse because the server never gave their report ids (no create in the package). */
  reportIdUnknown: number;
}

export interface ExportPlan {
  deviceId: string;
  identity: ExportIdentity;
  inspections: PlannedInspection[];
  outbox: OutboxJsonEntry[];
  photos: PlannedPhoto[];
  omitted: OmittedCounts;
  /** Quarantined inspections that hold something to export, whether or not they are taken. */
  quarantinedHolding: number;
  /** Inspections that hold something to export and are not quarantined. */
  unquarantinedHolding: number;
}

interface PackageRow {
  inspection_id: string;
  report_id: string | null;
  quarantine_source: string | null;
  server_confirmed: number;
}

interface OutboxRow {
  idempotency_key: string;
  op: string;
  payload: string;
  state: string;
  inspection_id: string | null;
  registry_version: number;
}

interface MediaRow {
  pending_id: string;
  inspection_id: string;
  kind: string;
  path: string;
  content_type: string;
  state: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsableReportId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** One queued write as the engine's outbox entry, or null when it cannot be written in the format. */
function toEntry(row: OutboxRow): OutboxJsonEntry | null {
  const def = findCommand(DEFAULT_REGISTRY, row.op);
  if (def === null || def.registryVersion !== Number(row.registry_version)) return null;
  if (!IDEMPOTENCY_KEY_PATTERN.test(row.idempotency_key)) return null;
  let parsed: Payload;
  try {
    const raw: unknown = JSON.parse(row.payload);
    parsed = def.parse(raw);
  } catch {
    return null;
  }
  const id = def.inspectionIdOf(parsed);
  if (id === null || id !== row.inspection_id || !PACKAGE_ID_PATTERN.test(id)) return null;
  if (row.op === 'inspection.create') return { idempotencyKey: row.idempotency_key, op: 'inspection.create', payload: { ...parsed, id } };
  if (row.op === 'inspection.update') {
    const changes = parsed.changes;
    if (!isRecord(changes)) return null;
    return { idempotencyKey: row.idempotency_key, op: 'inspection.update', payload: { ...changes, id } };
  }
  if (row.op === 'inspection.complete') return { idempotencyKey: row.idempotency_key, op: 'inspection.complete', payload: { id } };
  return null;
}

const countIn = (ids: readonly string[], among: ReadonlySet<string>): number => ids.filter((id) => among.has(id)).length;

/**
 * Decides, from the database alone and without writing anything, what an export holds.
 *
 * An inspection is taken when it belongs to this account, is not being purged, has an id the format accepts, and holds something
 * the server may not have: a queued write waiting to be sent, a photo that has not been uploaded, or stored Yjs updates that the
 * device cannot PROVE the server holds (`docIsCovered`: the server's own state vector, any doubt means "not covered"). That
 * narrowing applies only to an inspection the server confirmed and still lists: a quarantined one is taken whole.
 *
 * An inspection whose creation write was refused or cannot be written is left out entirely, with its Yjs state and photos: the
 * importer would not find the inspection and would refuse the whole package. Failed writes are never exported; they are counted.
 *
 * Quarantined inspections are taken only when `includeQuarantined` is set; then their parked (`orphaned`) writes go with them,
 * because that is the state quarantine holds a pending write in. Reads run in one transaction so the plan is one snapshot.
 */
export async function collectPlan(db: Db, identity: ExportIdentity, options: CollectOptions): Promise<ExportPlan> {
  return db.transaction(async (tx) => {
    const only = options.only === undefined ? null : new Set(options.only);
    const packages = await tx.query<PackageRow>('SELECT inspection_id, report_id, quarantine_source, server_confirmed FROM work_package WHERE tenant_id = ? AND user_id = ? AND purging = 0 ORDER BY inspection_id', [identity.tenantId, identity.userId]);
    const candidates = packages.filter((row) => PACKAGE_ID_PATTERN.test(row.inspection_id) && (only === null || only.has(row.inspection_id)));
    const known = new Map(candidates.map((row) => [row.inspection_id, row]));

    const docs = new Set((await tx.query<{ doc_name: string }>('SELECT DISTINCT doc_name FROM ydoc_updates')).map((row) => row.doc_name));
    const withDoc = candidates.filter((row) => docs.has(resultsDocName(row.inspection_id))).map((row) => row.inspection_id);

    const queued = await tx.query<OutboxRow>(
      "SELECT idempotency_key, op, payload, state, inspection_id, registry_version FROM outbox WHERE tenant_id = ? AND user_id = ? AND state IN ('pending', 'orphaned', 'failed') ORDER BY seq",
      [identity.tenantId, identity.userId],
    );
    const entries: { entry: OutboxJsonEntry; inspectionId: string }[] = [];
    const unwritable: string[] = [];
    const failed: string[] = [];
    const sending = new Set<string>();
    const creationRefused = new Set<string>();
    for (const row of queued) {
      const inspectionId = row.inspection_id;
      const owner = inspectionId === null ? undefined : known.get(inspectionId);
      if (owner === undefined || inspectionId === null) continue;
      if (row.state === 'failed') {
        failed.push(inspectionId);
        if (row.op === 'inspection.create') creationRefused.add(inspectionId);
        continue;
      }
      // A parked write is the quarantine's hold on a pending one; on an inspection that is not quarantined it means something else.
      if ((row.state === 'orphaned') !== (owner.quarantine_source !== null)) continue;
      sending.add(inspectionId);
      const entry = toEntry(row);
      if (entry !== null) entries.push({ entry, inspectionId });
      else if (row.op === 'inspection.create') creationRefused.add(inspectionId);
      else unwritable.push(inspectionId);
    }

    const mediaRows = await tx.query<MediaRow>('SELECT pending_id, inspection_id, kind, path, content_type, state FROM media ORDER BY created_at, pending_id');
    const photos: PlannedPhoto[] = [];
    const uploadedOwners = new Set<string>();
    const videoOwners = new Set<string>();
    const editOwners = new Set<string>();
    for (const row of mediaRows) {
      const owner = known.get(row.inspection_id);
      if (owner === undefined) continue;
      if (row.kind === 'video') videoOwners.add(row.inspection_id);
      else if (row.kind !== 'photo') editOwners.add(row.inspection_id);
      else if (isPackagePhotoType(row.content_type) && PACKAGE_ID_PATTERN.test(row.pending_id)) {
        // The server holds an uploaded photo, so it is left out. Only for an inspection the server still lists: a quarantined one is taken whole.
        if (row.state === 'uploaded' && owner.quarantine_source === null && Number(owner.server_confirmed) === 1) uploadedOwners.add(row.inspection_id);
        else photos.push({ pendingId: row.pending_id, inspectionId: row.inspection_id, contentType: row.content_type, path: row.path });
      }
    }

    const uncovered = new Set<string>();
    const provenCovered = new Set<string>();
    for (const id of withDoc) {
      const owner = known.get(id);
      const narrowable = owner !== undefined && owner.quarantine_source === null && Number(owner.server_confirmed) === 1;
      if (narrowable && (await docIsCovered(tx, resultsDocName(id)))) provenCovered.add(id);
      else uncovered.add(id);
    }

    const holding = new Set<string>([...uncovered, ...sending, ...photos.map((photo) => photo.inspectionId)]);
    const eligible = candidates.filter((row) => options.includeQuarantined || row.quarantine_source === null);
    const eligibleIds = new Set(eligible.map((row) => row.inspection_id));
    const refusedHere = [...creationRefused].filter((id) => eligibleIds.has(id));
    const holders = candidates.filter((row) => holding.has(row.inspection_id) && !creationRefused.has(row.inspection_id));
    const quarantinedHolding = holders.filter((row) => row.quarantine_source !== null).length;
    const taken = holders.filter((row) => eligibleIds.has(row.inspection_id));
    const takenIds = new Set(taken.map((row) => row.inspection_id));

    const outbox = entries.filter((item) => takenIds.has(item.inspectionId));
    const creating = new Set(outbox.filter((item) => item.entry.op === 'inspection.create').map((item) => item.inspectionId));
    const inspections: PlannedInspection[] = taken.map((row) => {
      const reportIdKnown = isUsableReportId(row.report_id);
      return { id: row.inspection_id, reportId: isUsableReportId(row.report_id) ? row.report_id : UNKNOWN_REPORT_ID, reportIdKnown, quarantined: row.quarantine_source !== null };
    });

    const device = await tx.query<{ value: unknown }>("SELECT value FROM device_state WHERE key = 'device_id'");
    const deviceValue = device[0]?.value;
    return {
      deviceId: typeof deviceValue === 'string' && deviceValue.length > 0 && deviceValue.length <= 128 ? deviceValue : UNKNOWN_DEVICE_ID,
      identity,
      inspections,
      outbox: outbox.map((item) => item.entry),
      photos: photos.filter((photo) => takenIds.has(photo.inspectionId)),
      omitted: {
        videos: countIn([...videoOwners], takenIds),
        photoEdits: countIn([...editOwners], takenIds),
        skippedWrites: countIn(unwritable, takenIds),
        failedWrites: countIn(failed, takenIds),
        creationRefused: refusedHere.length,
        alreadyOnServer: [...provenCovered, ...uploadedOwners].filter((id, at, all) => all.indexOf(id) === at && eligibleIds.has(id) && !takenIds.has(id) && !creationRefused.has(id)).length,
        reportIdUnknown: inspections.filter((row) => !row.reportIdKnown && !creating.has(row.id)).length,
      },
      quarantinedHolding,
      unquarantinedHolding: holders.length - quarantinedHolding,
    } satisfies ExportPlan;
  });
}
