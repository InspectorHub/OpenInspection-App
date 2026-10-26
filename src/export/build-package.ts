import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import * as Y from 'yjs';
import { resultsDocName } from '../collab/connector';
import { MAX_MEDIA_BYTES } from '../media/media-types';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import type { ExportPlan } from './collect';
import {
  MANIFEST_ENTRY,
  MEDIA_INDEX_ENTRY,
  OUTBOX_ENTRY,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  mediaEntryName,
  yjsEntryName,
  type MediaIndexRow,
} from './format';

/** Bytes gathered before one chunk goes to the file: bounds both the number of plugin calls and the memory held between them. */
export const FLUSH_BYTES = 256 * 1024;
/** Rows of one document read per query, so no single result grows with the document. */
const UPDATE_PAGE_SIZE = 100;

export interface BuildDeps {
  db: Db;
  files: Pick<Files, 'read'>;
  /** The UTC ISO instant written into the manifest. */
  exportedAt: string;
}

export interface BuildSummary {
  photosIncluded: number;
  /** Photos in the plan that could not be put in the package: unreadable, empty or over the size the engine accepts. */
  photosMissing: number;
}

export interface BuiltPackage {
  /** The archive, in pieces. One pass only; read the summary after it has been consumed. */
  chunks: AsyncIterable<Uint8Array>;
  summary(): BuildSummary;
}

/** Collects what the zip writer emits, so the generator can hand it on in sensible pieces. */
class Gather {
  private parts: Uint8Array[] = [];
  size = 0;
  failure: Error | null = null;

  push(data: Uint8Array): void {
    if (data.length === 0) return;
    this.parts.push(data);
    this.size += data.length;
  }

  take(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.size = 0;
    return out;
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error('A stored Yjs update is not binary');
}

/** The merged state of one inspection's results document: every stored update applied to an empty document, then encoded. */
export async function readMergedState(db: Db, inspectionId: string): Promise<Uint8Array> {
  const doc = new Y.Doc();
  try {
    let after = 0;
    for (;;) {
      const rows = await db.query<{ id: number; data: unknown }>('SELECT id, data FROM ydoc_updates WHERE doc_name = ? AND id > ? ORDER BY id LIMIT ?', [resultsDocName(inspectionId), after, UPDATE_PAGE_SIZE]);
      for (const row of rows) {
        Y.applyUpdate(doc, toBytes(row.data));
        after = Number(row.id);
      }
      if (rows.length < UPDATE_PAGE_SIZE) break;
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function addDeflated(zip: Zip, name: string, data: Uint8Array): void {
  const entry = new ZipDeflate(name, { level: 6 });
  zip.add(entry);
  entry.push(data, true);
}

/** Photos are already compressed; storing them as they are costs nothing and the bytes in the package are the bytes on the device. */
function addStored(zip: Zip, name: string, data: Uint8Array): void {
  const entry = new ZipPassThrough(name);
  zip.add(entry);
  entry.push(data, true);
}

/**
 * Writes the package as a stream. The Yjs state of one inspection, then one photo at a time, is read, handed to the zip writer
 * and let go before the next is read; what the writer emits is gathered into pieces of about `FLUSH_BYTES` and yielded, and the
 * caller writes each piece before asking for the next. The whole archive therefore never exists in memory.
 *
 * Entry order: the Yjs states, the photos, then the media index, the outbox and the manifest, because the index can only be
 * written once it is known which photos could be read. No entry has a name the engine would refuse.
 */
export function buildPackage(plan: ExportPlan, deps: BuildDeps): BuiltPackage {
  const summary: BuildSummary = { photosIncluded: 0, photosMissing: 0 };

  async function* generate(): AsyncGenerator<Uint8Array> {
    const gather = new Gather();
    const zip = new Zip((error, data) => {
      if (error) gather.failure = error;
      else gather.push(data);
    });
    const settle = (): void => {
      if (gather.failure) throw gather.failure;
    };

    for (const inspection of plan.inspections) {
      addDeflated(zip, yjsEntryName(inspection.id), await readMergedState(deps.db, inspection.id));
      settle();
      if (gather.size >= FLUSH_BYTES) yield gather.take();
    }

    const index: MediaIndexRow[] = [];
    for (const photo of plan.photos) {
      const name = mediaEntryName(photo.pendingId, photo.contentType);
      {
        let bytes: Uint8Array | null = null;
        try {
          bytes = await deps.files.read(photo.path);
        } catch {
          bytes = null;
        }
        if (bytes === null || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
          summary.photosMissing += 1;
          continue;
        }
        addStored(zip, name, bytes);
      }
      settle();
      index.push({ pendingId: photo.pendingId, inspectionId: photo.inspectionId, contentType: photo.contentType });
      summary.photosIncluded += 1;
      if (gather.size >= FLUSH_BYTES) yield gather.take();
    }

    addDeflated(zip, MEDIA_INDEX_ENTRY, encodeJson(index));
    addDeflated(zip, OUTBOX_ENTRY, encodeJson(plan.outbox));
    addDeflated(
      zip,
      MANIFEST_ENTRY,
      encodeJson({
        format: PACKAGE_FORMAT,
        version: PACKAGE_VERSION,
        tenantId: plan.identity.tenantId,
        deviceId: plan.deviceId,
        exportedBy: plan.identity.userId,
        exportedAt: deps.exportedAt,
        inspections: plan.inspections.map((inspection) => ({ id: inspection.id, reportId: inspection.reportId })),
      }),
    );
    zip.end();
    settle();
    if (gather.size > 0) yield gather.take();
  }

  return { chunks: generate(), summary: () => ({ ...summary }) };
}
