import { zipSync } from 'fflate';
import { readPackageSummary, type PackageSummary } from '@inspectorhub/offline-package';

/**
 * Packages for the import specs, written the way a device writes them (fflate over the documented entry names). They are never
 * judged by this file: a spec asks `readPackageSummary` or `runImport`, which parse them with the shared package's own schemas.
 */
export interface FixtureSpec {
  tenantId?: string;
  inspections: number;
  /** Photos per inspection index. */
  photos?: Readonly<Record<number, number>>;
  /** Queued updates per inspection index. */
  updates?: Readonly<Record<number, number>>;
  /** Extra bytes of Yjs state per inspection, to make a package bigger. */
  yjsBytes?: number;
  exportedAt?: string;
  /** A `label` written into the manifest entry of these inspections, whatever its type (hostile values included). */
  labels?: Readonly<Record<string, unknown>>;
}

export const inspectionId = (index: number): string => `insp-${String(index)}`;

const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** Deterministic bytes that differ per seed. */
export function bytesFor(seed: string, length: number): Uint8Array {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

export function makePackage(spec: FixtureSpec): { zip: Uint8Array; ids: string[]; summary: PackageSummary } {
  const ids = Array.from({ length: spec.inspections }, (_, i) => inspectionId(i));
  const outbox: unknown[] = [];
  const media: unknown[] = [];
  const files: Record<string, Uint8Array> = {};
  ids.forEach((id, i) => {
    files[`yjs/${id}.bin`] = bytesFor(`yjs-${id}`, spec.yjsBytes ?? 64);
    for (let j = 0; j < (spec.updates?.[i] ?? 0); j++) outbox.push({ idempotencyKey: `k-${id}-${String(j)}`, op: 'inspection.update', payload: { id, title: `title ${String(j)}` } });
    for (let n = 0; n < (spec.photos?.[i] ?? 0); n++) {
      const pendingId = `ph-${String(i)}-${String(n)}`;
      media.push({ pendingId, inspectionId: id, contentType: 'image/jpeg' });
      files[`media/${pendingId}.jpg`] = bytesFor(pendingId, 128);
    }
  });
  files['manifest.json'] = enc({
    format: 'openinspection-offline-package',
    version: 1,
    tenantId: spec.tenantId ?? 'tenant-1',
    deviceId: 'device-1',
    exportedBy: 'user-1',
    exportedAt: spec.exportedAt ?? '2026-10-20T09:30:00.000Z',
    inspections: ids.map((id, i) => ({ id, reportId: `rep-${String(i)}`, ...(spec.labels !== undefined && id in spec.labels ? { label: spec.labels[id] } : {}) })),
  });
  files['outbox.json'] = enc(outbox);
  files['media/index.json'] = enc(media);
  const zip = zipSync(files);
  return { zip, ids, summary: readPackageSummary(zip) };
}

/** A well-formed 200 body for the package `bytes`: what the engine answers when it confirms every inspection in it. */
export function confirmedBody(bytes: Uint8Array, extra: { applied?: number; skipped?: number; failed?: unknown[] } = {}): unknown {
  const { counts } = readPackageSummary(bytes);
  return {
    success: true,
    data: {
      inspections: counts.inspections,
      photos: counts.photos,
      outbox: { applied: extra.applied ?? counts.writes, skipped: extra.skipped ?? 0, failed: extra.failed ?? [] },
      yjs: { changed: counts.inspections, unchanged: 0 },
    },
  };
}

export function errorBody(code: string, details?: Record<string, unknown>): unknown {
  return { success: false, error: { code, message: code, ...(details === undefined ? {} : { details }) } };
}
