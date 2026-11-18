/**
 * Enumerate tenant media (E-2) and stream each object into planned zip volumes,
 * verifying size and sha256 as it goes. A bad object is retried a bounded number
 * of times, then recorded in `excluded` and skipped — the export continues
 * rather than failing wholesale (plan D10). Oversize objects are excluded too.
 *
 * Two request shapes are injected: `json` for the listing API (goes through the
 * restricted http client) and `bytes` for raw object bodies (a binary-safe path
 * that does NOT UTF-8-decode the body, which would corrupt photos/videos).
 */
import { Zip, ZipPassThrough } from 'fflate';
import { mapKeyToEntryName, VolumePlanner, zipEntryOverhead, sha256Hex } from '@inspectorhub/data-package';
import type {
  MediaDescriptor, MediaIndexRow, ExcludedItem, RunnerResponse, WrittenFile, ProgressFn,
} from './types';

const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_LIST_PAGES = 10_000;
const MAX_RETRIES = 3;

export interface BinaryResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
}

export interface MediaDeps {
  /** JSON listing request (restricted http client). */
  readonly json: (req: { url: string; headers: Record<string, string> }) => Promise<RunnerResponse>;
  /** Binary-safe object GET with a hard byte cap. */
  readonly bytes: (req: {
    url: string; headers: Record<string, string>; maxBytes: number;
  }) => Promise<BinaryResponse>;
  readonly mediaUrl: (cursor: string | null, limit: number) => string;
  readonly objectUrl: (key: string) => string;
  readonly headers: () => Record<string, string>;
  readonly log?: (line: string) => void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface MediaPage { objects: MediaDescriptor[]; cursor: string | null; truncated: boolean }

function parseMediaPage(json: unknown): MediaPage {
  if (!isObject(json) || !isObject(json.data) || !Array.isArray(json.data.objects)) throw new Error('media-response');
  const objects: MediaDescriptor[] = [];
  for (const item of json.data.objects) {
    if (!isObject(item) || typeof item.key !== 'string' || item.key.length === 0
        || !Number.isSafeInteger(item.size) || (item.size as number) < 0
        || typeof item.contentType !== 'string') throw new Error('media-object');
    objects.push({
      key: item.key, size: item.size as number,
      etag: typeof item.etag === 'string' ? item.etag : '',
      uploaded: typeof item.uploaded === 'number' && Number.isFinite(item.uploaded) ? item.uploaded : 0,
      contentType: item.contentType as string,
      kind: (['image', 'video', 'audio', 'document', 'other'] as const).includes(item.kind as never)
        ? item.kind as MediaDescriptor['kind'] : 'other',
    });
  }
  const cursor = json.data.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('media-cursor');
  return { objects, cursor: cursor as string | null, truncated: json.data.truncated === true };
}

/** List all media descriptors, following the opaque cursor. */
export async function listAllMedia(deps: MediaDeps): Promise<MediaDescriptor[]> {
  const all: MediaDescriptor[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (++pages > MAX_LIST_PAGES) throw new Error('media-too-many-pages');
    const res = await deps.json({ url: deps.mediaUrl(cursor, 1000), headers: deps.headers() });
    if (res.status !== 200) throw new Error(`media-status-${res.status}`);
    const page = parseMediaPage(res.json);
    all.push(...page.objects);
    cursor = page.truncated ? page.cursor : null;
    if (page.truncated && cursor === null) throw new Error('media-cursor-missing');
  } while (cursor !== null);
  return all;
}

export interface MediaDownloadResult {
  readonly rows: readonly MediaIndexRow[];
  readonly files: readonly WrittenFile[];
  readonly excluded: readonly ExcludedItem[];
  readonly failed: number;
}

/** Download, verify and volume-plan all media. Bad/oversize objects are excluded, not fatal. */
export async function downloadMedia(
  deps: MediaDeps,
  descriptors: readonly MediaDescriptor[],
  onProgress?: ProgressFn,
): Promise<MediaDownloadResult> {
  const planner = new VolumePlanner({ maxEntries: 60_000, maxBytes: 1024 * 1024 * 1024 });
  const rows: MediaIndexRow[] = [];
  const volumes = new Map<string, { entries: { name: string; bytes: Uint8Array }[] }>();
  const excluded: ExcludedItem[] = [];
  let failed = 0;

  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i]!;
    if (d.size > MAX_OBJECT_BYTES) {
      excluded.push({ class: 'oversize_media', table: 'media', reason: 'object exceeds byte budget', ids: [d.key] });
      continue;
    }
    let bytes: Uint8Array | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await deps.bytes({
          url: deps.objectUrl(d.key), headers: deps.headers(),
          maxBytes: Math.max(1, d.size * 2) + 1024,
        });
        if (res.status !== 200 && res.status !== 206) throw new Error(`object-status-${res.status}`);
        bytes = res.bytes;
        break;
      } catch {
        // retry; a persistently bad object is excluded below
      }
    }
    if (bytes === null) {
      excluded.push({ class: 'bad_media', table: 'media', reason: 'download failed after retries', ids: [d.key] });
      failed++;
      continue;
    }
    if (bytes.length !== d.size) {
      excluded.push({ class: 'bad_media', table: 'media', reason: 'size mismatch', ids: [d.key] });
      failed++;
      continue;
    }
    let mapped!: ReturnType<typeof mapKeyToEntryName>;
    let digest!: string;
    try {
      mapped = mapKeyToEntryName(d.key);
      digest = await sha256Hex(bytes);
    } catch {
      excluded.push({ class: 'bad_media', table: 'media', reason: 'unsafe key or hash failure', ids: [d.key] });
      failed++;
      continue;
    }
    const plan = planner.add(mapped.entry, d.size + zipEntryOverhead(mapped.entry.length));
    let volume = volumes.get(plan.volume);
    if (!volume) { volume = { entries: [] }; volumes.set(plan.volume, volume); }
    volume.entries.push({ name: mapped.entry, bytes });
    rows.push({
      key: d.key, entry: mapped.entry, bytes: d.size, sha256: digest, volume: plan.volume,
      content_type: d.contentType, referenced_by: [],
    });
    if (onProgress) await onProgress({ stage: 'media', rows: 0, media: i + 1, bytes: volume.entries.reduce((n, e) => n + e.bytes.length, 0), totalTables: 0, doneTables: 0 });
  }

  // Media volumes are real STORED zip archives (format contract in volume.ts).
  // ZipPassThrough writes entries without deflate, which is what the importer's
  // byte checks expect.
  const files: WrittenFile[] = [];
  for (const [name, volume] of volumes) {
    files.push({ path: name, bytes: await storedZip(volume.entries) });
  }
  deps.log?.(`media: ${rows.length} downloaded, ${failed} excluded`);
  return { rows, files, excluded, failed };
}

/** Build a real STORED (uncompressed) zip from entry name → bytes pairs. */
function storedZip(entries: readonly { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const zip = new Zip((err, data, final) => {
      if (err) { reject(err); return; }
      chunks.push(data);
      size += data.length;
      if (final) {
        const out = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        resolve(out);
      }
    });
    for (const entry of entries) {
      const pass = new ZipPassThrough(entry.name);
      zip.add(pass);
      pass.push(entry.bytes, true);
    }
    zip.end();
  });
}
