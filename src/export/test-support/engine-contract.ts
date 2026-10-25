/**
 * The engine's offline package contract (format v1) restated as plain checks, so the export tests judge a package
 * by the engine's own rules and not by the rules the builder happens to follow.
 *
 * Source of truth, read-only: OpenInspection `packages/offline-package/src/manifest.ts` (the zod schemas
 * `OfflinePackageManifestSchema`, `OutboxEntrySchema`, `MediaIndexSchema`, `OFFLINE_ID_PATTERN`) and
 * `packages/offline-package/src/format.ts` (`ALLOWED_ENTRY`, `parsePackage`). The app does not depend on zod, and the engine
 * package is a private workspace package, so the rules are copied here by hand. A one-off check against the engine's real
 * parser was run when this file was written (see the task report); keep the two in step when the engine changes the format.
 */

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const OPS = ['inspection.create', 'inspection.update', 'inspection.complete'];
const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic'];
const ID = ID_PATTERN.source.slice(1, -1);
export const ALLOWED_ENTRY = new RegExp(String.raw`^(?:manifest\.json|outbox\.json|media/index\.json|yjs/${ID}\.bin|media/${ID}\.(?:jpg|png|heic))$`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the list of violations; empty means the engine's schema would accept it. */
export function manifestViolations(value: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(value)) return ['manifest is not an object'];
  if (value.format !== 'openinspection-offline-package') out.push('format');
  if (value.version !== 1) out.push('version');
  if (typeof value.tenantId !== 'string' || !ID_PATTERN.test(value.tenantId)) out.push('tenantId');
  if (typeof value.deviceId !== 'string' || value.deviceId.length < 1 || value.deviceId.length > 128) out.push('deviceId');
  if (typeof value.exportedBy !== 'string' || !ID_PATTERN.test(value.exportedBy)) out.push('exportedBy');
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value.exportedAt)) out.push('exportedAt');
  const rows = value.inspections;
  if (!Array.isArray(rows) || rows.length < 1) out.push('inspections: at least one is required');
  else {
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || !ID_PATTERN.test(row.id)) out.push('inspections[].id');
      else if (typeof row.reportId !== 'string' || row.reportId.length < 1 || row.reportId.length > 128) out.push('inspections[].reportId');
    }
    const ids = rows.map((row) => (isRecord(row) ? row.id : null));
    if (new Set(ids).size !== ids.length) out.push('inspections: duplicate id');
  }
  return out;
}

export function outboxViolations(value: unknown): string[] {
  if (!Array.isArray(value)) return ['outbox is not an array'];
  const out: string[] = [];
  const keys: unknown[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      out.push('entry is not an object');
      continue;
    }
    const extra = Object.keys(entry).filter((key) => !['idempotencyKey', 'op', 'payload'].includes(key));
    if (extra.length > 0) out.push(`unknown envelope key: ${extra.join(',')}`);
    if (typeof entry.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(entry.idempotencyKey)) out.push('idempotencyKey');
    keys.push(entry.idempotencyKey);
    if (typeof entry.op !== 'string' || !OPS.includes(entry.op)) out.push('op');
    if (!isRecord(entry.payload) || typeof entry.payload.id !== 'string' || !ID_PATTERN.test(entry.payload.id)) out.push('payload.id');
  }
  if (new Set(keys).size !== keys.length) out.push('duplicate idempotency key');
  return out;
}

export function mediaIndexViolations(value: unknown): string[] {
  if (!Array.isArray(value)) return ['media index is not an array'];
  const out: string[] = [];
  const ids: unknown[] = [];
  for (const row of value) {
    if (!isRecord(row)) {
      out.push('row is not an object');
      continue;
    }
    if (typeof row.pendingId !== 'string' || !ID_PATTERN.test(row.pendingId)) out.push('pendingId');
    if (typeof row.inspectionId !== 'string' || !ID_PATTERN.test(row.inspectionId)) out.push('inspectionId');
    if (typeof row.contentType !== 'string' || !CONTENT_TYPES.includes(row.contentType)) out.push('contentType');
    ids.push(row.pendingId);
  }
  if (new Set(ids).size !== ids.length) out.push('duplicate pending id');
  return out;
}
