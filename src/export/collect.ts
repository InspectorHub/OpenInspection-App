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
  quarantined: boolean;
}

export interface PlannedPhoto {
  pendingId: string;
  inspectionId: string;
  contentType: PackagePhotoType;
  /** Relative to the app's storage; read file by file. */
  path: string;
}

/** What the format cannot carry or the exporter could not express, so the person can be told. Counts only. */
export interface OmittedCounts {
  /** Recorded clips: the package has no place for video. */
  videos: number;
  /** Crops and annotations of a photo: the package indexes a photo by id and type only. */
  photoEdits: number;
  /** Queued writes that could not be written in the format (unknown command, damaged payload, an id the format refuses). */
  skippedWrites: number;
}

export interface ExportPlan {
  deviceId: string;
  identity: ExportIdentity;
  inspections: PlannedInspection[];
  outbox: OutboxJsonEntry[];
  photos: PlannedPhoto[];
  omitted: OmittedCounts;
  /** Inspections of this account that hold something to export and are quarantined. Always counted, whether or not they are taken. */
  quarantinedHolding: number;
  /** Inspections of this account that hold something to export and are not quarantined. */
  unquarantinedHolding: number;
}

interface PackageRow {
  inspection_id: string;
  report_id: string | null;
  quarantine_source: string | null;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Decides, from the database alone and without writing anything, what an export holds.
 *
 * An inspection is taken when it belongs to this account, is not being purged, has an id the format accepts, and holds
 * something of the person's: stored Yjs updates, a queued write waiting to be sent, or a photo. The rest of the work list is
 * downloaded data the server already has. Quarantined inspections are taken only when `includeQuarantined` is set; then their
 * parked (`orphaned`) writes go with them, because that is the state quarantine holds a pending write in.
 *
 * Reads run in one transaction so the plan is one snapshot.
 */
export async function collectPlan(db: Db, identity: ExportIdentity, options: CollectOptions): Promise<ExportPlan> {
  return db.transaction(async (tx) => {
    const only = options.only === undefined ? null : new Set(options.only);
    const packages = await tx.query<PackageRow>('SELECT inspection_id, report_id, quarantine_source FROM work_package WHERE tenant_id = ? AND user_id = ? AND purging = 0 ORDER BY inspection_id', [identity.tenantId, identity.userId]);
    const candidates = packages.filter((row) => PACKAGE_ID_PATTERN.test(row.inspection_id) && (only === null || only.has(row.inspection_id)));
    const known = new Map(candidates.map((row) => [row.inspection_id, row]));

    const docs = await tx.query<{ doc_name: string }>('SELECT DISTINCT doc_name FROM ydoc_updates');
    const withDoc = new Set(docs.map((row) => row.doc_name).filter((name) => name.startsWith('results-')).map((name) => name.slice('results-'.length)));

    const omitted: OmittedCounts = { videos: 0, photoEdits: 0, skippedWrites: 0 };
    const queued = await tx.query<OutboxRow>(
      "SELECT idempotency_key, op, payload, state, inspection_id, registry_version FROM outbox WHERE tenant_id = ? AND user_id = ? AND state IN ('pending', 'orphaned') ORDER BY seq",
      [identity.tenantId, identity.userId],
    );
    const entries: { entry: OutboxJsonEntry; inspectionId: string }[] = [];
    const unwritable: string[] = [];
    for (const row of queued) {
      const inspectionId = row.inspection_id;
      const owner = inspectionId === null ? undefined : known.get(inspectionId);
      if (owner === undefined || inspectionId === null) continue;
      const quarantined = owner.quarantine_source !== null;
      // A parked write is the quarantine's hold on a pending one; on an inspection that is not quarantined it means something else.
      if ((row.state === 'orphaned') !== quarantined) continue;
      const entry = toEntry(row);
      if (entry === null) unwritable.push(inspectionId);
      else entries.push({ entry, inspectionId });
    }

    const mediaRows = await tx.query<MediaRow>('SELECT pending_id, inspection_id, kind, path, content_type FROM media ORDER BY created_at, pending_id');
    const photos: PlannedPhoto[] = [];
    const videoOwners: string[] = [];
    const editOwners: string[] = [];
    for (const row of mediaRows) {
      if (!known.has(row.inspection_id)) continue;
      if (row.kind === 'video') videoOwners.push(row.inspection_id);
      else if (row.kind !== 'photo') editOwners.push(row.inspection_id);
      else if (isPackagePhotoType(row.content_type) && PACKAGE_ID_PATTERN.test(row.pending_id)) {
        photos.push({ pendingId: row.pending_id, inspectionId: row.inspection_id, contentType: row.content_type, path: row.path });
      }
    }

    const holding = new Set<string>([...withDoc, ...entries.map((item) => item.inspectionId), ...photos.map((photo) => photo.inspectionId)]);
    const holders = candidates.filter((row) => holding.has(row.inspection_id));
    const quarantinedHolding = holders.filter((row) => row.quarantine_source !== null).length;
    const taken = holders.filter((row) => options.includeQuarantined || row.quarantine_source === null);
    const takenIds = new Set(taken.map((row) => row.inspection_id));
    omitted.skippedWrites = unwritable.filter((id) => takenIds.has(id)).length;
    omitted.videos = videoOwners.filter((id) => takenIds.has(id)).length;
    omitted.photoEdits = editOwners.filter((id) => takenIds.has(id)).length;

    const device = await tx.query<{ value: unknown }>("SELECT value FROM device_state WHERE key = 'device_id'");
    const deviceValue = device[0]?.value;
    return {
      deviceId: typeof deviceValue === 'string' && deviceValue.length > 0 && deviceValue.length <= 128 ? deviceValue : UNKNOWN_DEVICE_ID,
      identity,
      inspections: taken.map((row) => ({
        id: row.inspection_id,
        reportId: typeof row.report_id === 'string' && row.report_id.length > 0 && row.report_id.length <= 128 ? row.report_id : UNKNOWN_REPORT_ID,
        quarantined: row.quarantine_source !== null,
      })),
      outbox: entries.filter((item) => takenIds.has(item.inspectionId)).map((item) => item.entry),
      photos: photos.filter((photo) => takenIds.has(photo.inspectionId)),
      omitted,
      quarantinedHolding,
      unquarantinedHolding: holders.length - quarantinedHolding,
    } satisfies ExportPlan;
  });
}
