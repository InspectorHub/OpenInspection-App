import { unzipSync, zipSync } from 'fflate';
import { MANIFEST_ENTRY } from '../export/format';
import { cleanLabel } from './cached-address';

/**
 * The optional `label` an exporting device writes beside `id` and `reportId` in each manifest entry (the address it had cached).
 *
 * The shared package's manifest schema ignores keys it does not know, so the label is a compatible addition within version 1: an
 * older app or server reads the same package and never sees it. For the same reason the shared reader strips it, so it is read here
 * from the manifest bytes already in memory.
 *
 * Everything in a package is a claim of whoever made it, so a label is used only when it is a string for an id the caller expects
 * (the ids of the manifest the shared reader accepted), is the only entry for that id, and is non-empty once cleaned. Anything else
 * is dropped without a word and the inspection is shown by its id.
 */

const MEDIA_INDEX_ENTRY = 'media/index.json';

/**
 * Writes labels into a package the shared library cut (a left-behind part for "Save"). The library keeps the manifest's own keys but
 * rebuilds each inspection entry from the few fields it knows, so a part comes out without labels. The labels are put back for the
 * inspections the part holds, and for no other, so a part never carries the address of an inspection that is not in it.
 *
 * Nothing but the manifest changes: every other entry is carried over byte for byte (photos are stored, not compressed again).
 * Without anything to write, or if the part cannot be read, the part is returned as it is: a label is never worth a failed save.
 */
export function withLabels(part: Uint8Array, labels: ReadonlyMap<string, string>): Uint8Array {
  if (labels.size === 0) return part;
  try {
    const files = unzipSync(part);
    const raw = files[MANIFEST_ENTRY];
    if (raw === undefined) return part;
    const manifest: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (typeof manifest !== 'object' || manifest === null || !('inspections' in manifest) || !Array.isArray(manifest.inspections)) return part;
    let changed = false;
    const inspections = (manifest.inspections as unknown[]).map((row) => {
      if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') return row;
      const label = cleanLabel(labels.get(row.id));
      if (label === null) return row;
      changed = true;
      return { ...row, label };
    });
    if (!changed) return part;
    const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    for (const [name, data] of Object.entries(files)) {
      if (name === MANIFEST_ENTRY) entries[name] = new TextEncoder().encode(JSON.stringify({ ...manifest, inspections }));
      else entries[name] = name.startsWith('media/') && name !== MEDIA_INDEX_ENTRY ? [data, { level: 0 }] : data;
    }
    return zipSync(entries);
  } catch {
    return part;
  }
}

/** A manifest this large is not read for labels: the shared reader's own limits are far lower. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export function readLabels(zip: Uint8Array, ids: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  try {
    const files = unzipSync(zip, { filter: (file) => file.name === MANIFEST_ENTRY && file.originalSize <= MAX_MANIFEST_BYTES });
    const entry = files[MANIFEST_ENTRY];
    if (entry === undefined) return labels;
    const manifest: unknown = JSON.parse(new TextDecoder().decode(entry));
    if (typeof manifest !== 'object' || manifest === null || !('inspections' in manifest) || !Array.isArray(manifest.inspections)) return labels;
    const wanted = new Set(ids);
    const seen = new Set<string>();
    const ambiguous = new Set<string>();
    for (const row of manifest.inspections as unknown[]) {
      if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') continue;
      const id = row.id;
      if (!wanted.has(id)) continue;
      if (seen.has(id)) {
        ambiguous.add(id);
        continue;
      }
      seen.add(id);
      const label = 'label' in row ? cleanLabel(row.label) : null;
      if (label !== null) labels.set(id, label);
    }
    for (const id of ambiguous) labels.delete(id);
  } catch {
    return new Map();
  }
  return labels;
}
