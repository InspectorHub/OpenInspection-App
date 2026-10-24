import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { readSyncMarker, writeSyncMarker } from '../offline/sync-marker';
import type { Db } from '../platform/db';

/**
 * Proof that the server already holds everything a device has stored for one results document.
 *
 * The sync protocol gives a client no acknowledgement of the updates it sent (see `engineAckProposal`), so the
 * only thing a client can ever learn about the server is what the SERVER ITSELF says it has: its state vector in
 * its sync step 1, and the deleted ranges in its sync step 2. The connector records exactly those two things,
 * at the moment it observes them, and nothing else: never on connect, never on a socket opening, never when the
 * client sends its own step 2 or an update. `docIsCovered` then asks whether what is stored on the device is a
 * subset of what the server said it had.
 *
 * Two rows per document in `ydoc_sync`:
 *  - `results-<id>`: the server state vector (the format the Yjs encoder writes), from its latest step 1;
 *  - `ds:results-<id>`: the deleted ranges of the server document, from its latest step 2 (this module's format,
 *    see `encodeRanges`). A state vector says nothing about deletions: removing a value that the server already
 *    has, or overwriting one, leaves every clock unchanged, so a device that only deleted offline would look
 *    covered. The second row closes that. A new state vector observation removes it, so the two rows always come
 *    from one connection.
 *
 * The conservative hole, on purpose: whatever the server received AFTER it sent the step 1 (the updates this
 * device sent in the same connection, even when they were delivered) is not recognised until the NEXT handshake
 * shows the server holding it. Until then the document counts as unsent and the decision is "quarantine", never
 * "purge". A marker can only err towards keeping data.
 */

/** A document larger than this is never loaded just to answer the question; it counts as not covered. */
export const MAX_COVERAGE_SCRATCH_BYTES = 5 * 1024 * 1024;
const ROWS_PER_PAGE = 100;
/** More ranges than this in a stored delete set is not a delete set. */
const MAX_RANGES = 1_000_000;

/** The `ydoc_sync` key of a document's delete set row. */
export function deleteSetKey(docName: string): string {
  return `ds:${docName}`;
}

type Ranges = Map<number, { clock: number; len: number }[]>;

/** Sorted, with touching and overlapping ranges merged, empty ones dropped. */
function normalize(clients: ReadonlyMap<number, readonly { clock: number; len: number }[]>): Ranges {
  const out: Ranges = new Map();
  for (const [client, items] of clients) {
    const sorted = items.filter((item) => item.len > 0).map((item) => ({ clock: item.clock, len: item.len })).sort((a, b) => a.clock - b.clock);
    const merged: { clock: number; len: number }[] = [];
    for (const item of sorted) {
      const last = merged[merged.length - 1];
      if (last !== undefined && item.clock <= last.clock + last.len) last.len = Math.max(last.len, item.clock + item.len - last.clock);
      else merged.push(item);
    }
    if (merged.length > 0) out.set(client, merged);
  }
  return out;
}

function encodeRanges(ranges: Ranges): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, ranges.size);
  for (const [client, items] of ranges) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, items.length);
    for (const item of items) {
      encoding.writeVarUint(encoder, item.clock);
      encoding.writeVarUint(encoder, item.len);
    }
  }
  return encoding.toUint8Array(encoder);
}

/** Strict: anything that is not exactly what `encodeRanges` writes (unsorted, overlapping, trailing bytes) is rejected. */
function decodeRanges(bytes: Uint8Array): Ranges {
  const decoder = decoding.createDecoder(bytes);
  const clients = decoding.readVarUint(decoder);
  const out: Ranges = new Map();
  let total = 0;
  for (let i = 0; i < clients; i += 1) {
    const client = decoding.readVarUint(decoder);
    const count = decoding.readVarUint(decoder);
    total += count;
    if (count === 0 || total > MAX_RANGES || out.has(client)) throw new Error('Invalid delete set');
    const items: { clock: number; len: number }[] = [];
    let end = -1;
    for (let j = 0; j < count; j += 1) {
      const clock = decoding.readVarUint(decoder);
      const len = decoding.readVarUint(decoder);
      if (len === 0 || clock <= end) throw new Error('Invalid delete set');
      items.push({ clock, len });
      end = clock + len;
    }
    out.set(client, items);
  }
  if (decoding.hasContent(decoder)) throw new Error('Invalid delete set');
  return out;
}

function rangesOf(update: Uint8Array): Ranges {
  return normalize(Y.decodeUpdate(update).ds.clients);
}

/** Every range of `inner` lies inside one range of `outer`. */
function containsRanges(outer: Ranges, inner: Ranges): boolean {
  for (const [client, items] of inner) {
    const available = outer.get(client);
    if (available === undefined) return false;
    for (const item of items) {
      if (!available.some((range) => range.clock <= item.clock && range.clock + range.len >= item.clock + item.len)) return false;
    }
  }
  return true;
}

/**
 * Records the state vector the server announced in its sync step 1, replacing the earlier one, and drops the
 * delete set row of the earlier observation. Throws when the bytes are not a state vector, and then writes nothing.
 */
export async function recordServerStateVector(db: Db, docName: string, serverStateVector: Uint8Array, now: number): Promise<void> {
  Y.decodeStateVector(serverStateVector);
  await db.transaction(async (tx) => {
    await writeSyncMarker(tx, docName, serverStateVector, now);
    await tx.run('DELETE FROM ydoc_sync WHERE doc_name = ?', [deleteSetKey(docName)]);
  });
}

/** Records the deleted ranges the server sent in its sync step 2 (the whole update is read, only its deletions are kept). Throws when it cannot be read. */
export async function recordServerDeleteSet(db: Db, docName: string, serverStepTwoUpdate: Uint8Array, now: number): Promise<void> {
  const bytes = encodeRanges(rangesOf(serverStepTwoUpdate));
  await writeSyncMarker(db, deleteSetKey(docName), bytes, now);
}

/** Forgets what the server said about one document (its document was replaced or removed on this device). */
export async function clearSyncProof(db: Db, docName: string): Promise<void> {
  await db.run('DELETE FROM ydoc_sync WHERE doc_name IN (?, ?)', [docName, deleteSetKey(docName)]);
}

async function loadScratch(db: Db, docName: string, maxBytes: number): Promise<Y.Doc | null> {
  const stats = await db.query<{ bytes: number | null }>('SELECT SUM(LENGTH(data)) AS bytes FROM ydoc_updates WHERE doc_name = ?', [docName]);
  if (Number(stats[0]?.bytes ?? 0) > maxBytes) return null;
  const scratch = new Y.Doc();
  let loaded = 0;
  let after = 0;
  try {
    for (;;) {
      const page = await db.query<{ id: number; data: unknown }>('SELECT id, data FROM ydoc_updates WHERE doc_name = ? AND id > ? ORDER BY id LIMIT ?', [docName, after, ROWS_PER_PAGE]);
      for (const row of page) {
        if (!(row.data instanceof Uint8Array)) throw new Error('A stored Yjs update is not binary');
        loaded += row.data.byteLength;
        if (loaded > maxBytes) throw new Error('The stored document is larger than the limit');
        Y.applyUpdate(scratch, row.data);
      }
      const last = page[page.length - 1];
      if (last === undefined || page.length < ROWS_PER_PAGE) break;
      after = Number(last.id);
    }
  } catch {
    scratch.destroy();
    return null;
  }
  if (scratch.store.pendingStructs !== null || scratch.store.pendingDs !== null) {
    scratch.destroy();
    return null;
  }
  return scratch;
}

export interface CoverageOptions {
  /** The most stored bytes loaded to answer; a larger document is reported as not covered. */
  maxBytes?: number;
}

/**
 * True only when the server's recorded state vector covers every client clock this device has stored for the
 * document AND the server's recorded deleted ranges contain every deletion stored here. A document with
 * nothing stored is covered. Anything that cannot be established (no marker, a marker that does not decode, a row
 * that cannot be read or applied, a history with gaps, a document over the size limit) is NOT covered. The
 * only side effect is reading; the stored document is loaded into a scratch document that is then destroyed.
 */
export async function docIsCovered(db: Db, docName: string, options: CoverageOptions = {}): Promise<boolean> {
  const scratch = await loadScratch(db, docName, options.maxBytes ?? MAX_COVERAGE_SCRATCH_BYTES);
  if (scratch === null) return false;
  try {
    const local = Y.decodeStateVector(Y.encodeStateVector(scratch));
    const deleted = rangesOf(Y.encodeStateAsUpdate(scratch));
    if (local.size === 0 && deleted.size === 0) return true;

    const marker = await readSyncMarker(db, docName);
    if (marker === null) return false;
    let server: Map<number, number>;
    try {
      server = Y.decodeStateVector(marker.coveredState);
    } catch {
      return false;
    }
    for (const [client, clock] of local) if ((server.get(client) ?? 0) < clock) return false;
    if (deleted.size === 0) return true;

    const deletions = await readSyncMarker(db, deleteSetKey(docName));
    if (deletions === null) return false;
    try {
      return containsRanges(decodeRanges(deletions.coveredState), deleted);
    } catch {
      return false;
    }
  } finally {
    scratch.destroy();
  }
}

/**
 * Proposal for the engine (a change to `server/durable-objects/inspection-doc.ts`; none is made here): the optional
 * acknowledgement that would make the marker exact instead of one handshake behind.
 *
 * Today the document object answers a client's sync step 1 with a step 2 and applies a client's step 2 or update
 * with no reply at all. After applying a client's update it could send one small frame back to that socket only:
 *
 *   byte 3 (MSG_ACK), then the server state vector as it is AFTER applying the update.
 *
 * `MSG_ACK` is a new framing byte next to `MSG_SYNC = 0` and `MSG_RESTORE = 2`. A client that does not know the byte
 * already ignores it (`onFrame` returns for any kind other than the two it knows), so the frame can ship before the
 * clients, and the web editor is unaffected. The native connector would record that state vector exactly like the
 * one from a step 1 (`recordServerStateVector`), which makes every update the server has applied recognised at
 * once, and shortens the conservative hole to the updates still in flight. To keep the frame rate bounded the
 * object can coalesce: at most one ack per socket per 250 ms, always carrying the newest vector.
 * The same frame sent once right after the object applied a client's step 2 would let a device that edited offline
 * and then synced learn that it is covered without a second connection.
 */
export type engineAckProposal = null;
