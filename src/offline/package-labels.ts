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

/** A manifest this large is not read for labels: the shared reader's own limits are far lower. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Makes the manifest entries of a package the shared library cut (a left-behind part for "Save") exactly `{ id, reportId }` plus a
 * clean `label` where the original file had a usable one, and nothing else.
 *
 * Two library behaviours meet here. Until the library keeps an entry's own keys, a part comes out without its labels, so they are put
 * back. Once it keeps them (the fix that carries every key of the raw entry into the part), the part carries whatever the untrusted
 * file put there: a `label` that is an object or megabytes long, and any other key. A part is a file the person shares onward, so the
 * entries are rebuilt from the known keys only, and the label comes from the map that was already cleaned at read time, never from the
 * part. Both situations are the same rule, and it holds whichever library version is installed.
 *
 * What is NOT rebuilt, and passes through as it is: a row that is not an object with a string `id`, any manifest key other than
 * `inspections`, and a manifest bigger than the read limit (it is not read at all). The importer's own validation decides about those.
 *
 * The zip is only rewritten when an entry actually differs: the manifest alone is read first (a filtered unzip, a few kilobytes), so
 * the common case, an honest part with the right labels, costs nothing and inflates nothing. When it does rewrite, nothing but the
 * manifest changes: every other entry is carried over byte for byte (photos are stored, not compressed again). The most that can be
 * inflated is one package within the importer's own ceilings (24 MiB compressed, 72 MiB unpacked). If the part cannot be read, it is
 * returned as it is: a label is never worth a failed save.
 */
export function withLabels(part: Uint8Array, labels: ReadonlyMap<string, string>): Uint8Array {
  try {
    const head = unzipSync(part, { filter: (file) => file.name === MANIFEST_ENTRY && file.originalSize <= MAX_MANIFEST_BYTES });
    const raw = head[MANIFEST_ENTRY];
    if (raw === undefined) return part;
    const manifest: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (typeof manifest !== 'object' || manifest === null || !('inspections' in manifest) || !Array.isArray(manifest.inspections)) return part;
    let changed = false;
    const inspections = (manifest.inspections as unknown[]).map((row) => {
      if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') return row;
      const label = cleanLabel(labels.get(row.id));
      const entry: Record<string, unknown> = { id: row.id };
      const reportId = (row as { reportId?: unknown }).reportId;
      if (typeof reportId === 'string') entry.reportId = reportId;
      if (label !== null) entry.label = label;
      if (!sameEntry(row as Record<string, unknown>, entry)) changed = true;
      return entry;
    });
    if (!changed) return part;
    const files = unzipSync(part);
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

/** Whether two manifest entries hold the same keys and the same values (the order of the keys is not a difference). */
function sameEntry(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

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
