/**
 * Bounded ZIP reader for tenant data packages (A-5). The desktop machine — not
 * the server — opens the package, so all hostile-input defence lives here.
 *
 * Ported from the engine's native/offline-zip.ts, which is the reference for:
 *  - finding the end-of-central-directory without trusting a length claim,
 *  - refusing ZIP64, duplicate names, unsupported compression, lying lengths,
 *    overlapping data regions and more compressed bytes than a deflate encoder
 *    could honestly produce for the declared size,
 *  - inflating into a RIGHT-SIZED buffer and giving up the moment an entry
 *    produces more than it declared (a compression bomb costs at most the
 *    declared size, never the compressed payload expanded).
 *
 * Nothing here imports the format package's schema: entry names are validated
 * with its `entryNameProblem`/`assertNoDuplicateEntryNames` at the preflight
 * layer. This module only answers "does this zip tell the truth about itself,
 * and give me one entry's bytes bounded by what it declares".
 *
 * Bytes never cross IPC: the renderer sends a file PATH; main reads it here.
 */
import { Inflate, unzipSync, type UnzipFileFilter } from 'fflate';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const MIN_SLICE = 128;
const SLICE_SHIFT = 9;

/** Default ceilings. A data package is bounded well below these in practice. */
export const ZIP_READ_LIMITS = {
    maxEntries: 65_000,
    maxUncompressedBytes: 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024, // below ZIP64
    maxSingleEntryBytes: 1024 * 1024 * 1024,
} as const;

export interface DirectoryEntry {
    readonly method: number;
    readonly compressedSize: number;
    readonly dataStart: number;
}

export type Listing =
    | { ok: true; entries: ReadonlyMap<string, number> } // name -> declared size
    | { ok: false; reason: string };

function maxCompressedFor(declared: number): number {
    return declared + Math.ceil(declared / 256) + 128;
}

/**
 * Read the central directory exactly as a decoder would, refusing anything
 * that cannot be placed with certainty. No bytes are inflated here.
 */
function readDirectory(zip: Uint8Array): { ok: true; entries: Map<string, DirectoryEntry> } | { ok: false; reason: string } {
    const bad = (reason: string) => ({ ok: false as const, reason });
    if (zip.length < 22) return bad('not a valid zip archive');
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = zip.length - 22;
    while (view.getUint32(eocd, true) !== EOCD_SIGNATURE) {
        if (eocd === 0 || zip.length - eocd > 65558) return bad('not a valid zip archive');
        eocd--;
    }
    const count = view.getUint16(eocd + 8, true);
    let at = view.getUint32(eocd + 16, true);
    if (count === 0xffff || at === ZIP64_MARKER) return bad('ZIP64 archives are not supported');

    const entries = new Map<string, DirectoryEntry>();
    for (let i = 0; i < count; i++) {
        if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) return bad('not a valid zip archive');
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const compressedSize = view.getUint32(at + 20, true);
        const originalSize = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        // Encryption (flag bit 0), ZIP64 sentinels and unknown compression all
        // make the entry unreadable with certainty — refuse.
        if (compressedSize === ZIP64_MARKER || originalSize === ZIP64_MARKER || localOffset === ZIP64_MARKER || (flags & 1) !== 0) {
            return bad('unsupported zip entry');
        }
        if (at + 46 + nameLength > zip.length) return bad('not a valid zip archive');
        let name = '';
        for (let k = 0; k < nameLength; k++) name += String.fromCharCode(zip[at + 46 + k]!);
        if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) return bad('not a valid zip archive');
        const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        if (dataStart + compressedSize > zip.length) return bad('entry data lies outside the archive');
        if (method === 0 && compressedSize !== originalSize) return bad(`entry ${name} declared a stored length that disagrees`);
        if (method === 8 && compressedSize > maxCompressedFor(originalSize)) return bad(`entry ${name} carries more compressed data than its size allows`);
        if (entries.has(name)) return bad('duplicate entry name');
        entries.set(name, { method, compressedSize, dataStart });
        at += 46 + nameLength + extraLength + commentLength;
    }

    // Data regions must be disjoint; an entry cannot share another's bytes.
    const regions = [...entries].filter(([, e]) => e.compressedSize > 0).sort((x, y) => x[1].dataStart - y[1].dataStart);
    for (let i = 1; i < regions.length; i++) {
        const previous = regions[i - 1]![1];
        const [name, current] = regions[i]!;
        if (current.dataStart < previous.dataStart + previous.compressedSize) {
            return bad(`entry ${name} shares compressed data with another entry`);
        }
    }
    return { ok: true, entries };
}

/**
 * Judge the package from its directory alone. `fflate.unzipSync` with a filter
 * that collects names but inflates nothing lets us count entries, reject
 * duplicates/unexpected names and cap total declared size before producing a
 * single byte — then readDirectory adds the data-region checks.
 */
export function listPackage(
    zip: Uint8Array,
    limits: { entries?: number; uncompressedBytes?: number; singleEntryBytes?: number } = {},
    allowedEntry?: (name: string) => boolean,
): Listing {
    const maxEntries = limits.entries ?? ZIP_READ_LIMITS.maxEntries;
    const maxTotal = limits.uncompressedBytes ?? ZIP_READ_LIMITS.maxUncompressedBytes;
    const maxSingle = limits.singleEntryBytes ?? ZIP_READ_LIMITS.maxSingleEntryBytes;
    const entries = new Map<string, number>();
    let refusal: string | null = null;
    let seen = 0;
    let total = 0;
    const note = (info: { name: string; originalSize: number; compression: number }): false => {
        seen++;
        if (refusal) return false;
        if (seen > maxEntries) refusal = 'too many entries';
        else if (entries.has(info.name)) refusal = 'duplicate entry name';
        else if (allowedEntry && !allowedEntry(info.name)) refusal = `unexpected entry: ${info.name}`;
        else if (info.compression !== 0 && info.compression !== 8) refusal = 'unsupported compression';
        else if (info.originalSize > maxSingle) refusal = `entry too large: ${info.name}`;
        else {
            total += info.originalSize;
            if (total > maxTotal) refusal = 'package too large once unpacked';
            else entries.set(info.name, info.originalSize);
        }
        return false; // never inflate during listing
    };
    try {
        unzipSync(zip, { filter: note as UnzipFileFilter });
    } catch {
        return { ok: false, reason: 'not a valid zip archive' };
    }
    if (refusal) return { ok: false, reason: refusal };
    const directory = readDirectory(zip);
    if (!directory.ok) return directory;
    return { ok: true, entries };
}

/** Inflate a deflate stream, abandoning it the moment it passes `declared`. */
function inflateBounded(data: Uint8Array, declared: number, out: Uint8Array): boolean {
    let produced = 0;
    let over = false;
    const inflater = new Inflate((chunk) => {
        if (over) return;
        if (produced + chunk.byteLength > declared) { over = true; return; }
        out.set(chunk, produced);
        produced += chunk.byteLength;
    });
    try {
        for (let at = 0; at < data.length && !over;) {
            const end = Math.min(data.length, at + Math.max(MIN_SLICE, (declared - produced) >> SLICE_SHIFT));
            inflater.push(data.subarray(at, end), end === data.length);
            at = end;
        }
    } catch {
        return false;
    }
    return !over && produced === declared;
}

function inflateExact(zip: Uint8Array, entry: DirectoryEntry | undefined, declared: number, out: Uint8Array): number | null {
    if (!entry) return null;
    const data = zip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    if (entry.method === 0) {
        if (entry.compressedSize !== declared) return null;
        out.set(data);
        return declared;
    }
    if (entry.method !== 8) return null;
    if (data.length > maxCompressedFor(declared)) return null;
    if (data.length === 0) return declared === 0 ? 0 : null;
    return inflateBounded(data, declared, out) ? declared : null;
}

/**
 * Yield each wanted entry's bytes, right-sized to its declared length. An entry
 * that does not inflate to exactly that size (damaged or lying archive) yields
 * null. The caller should drop one entry before asking for the next so the
 * working set stays the compressed package plus a single entry.
 */
export function* readPackageEntries(
    zip: Uint8Array,
    wanted: ReadonlyMap<string, number>,
): Generator<[name: string, bytes: Uint8Array | null]> {
    const directory = readDirectory(zip);
    for (const [name, declared] of wanted) {
        if (!directory.ok) { yield [name, null]; continue; }
        const out = new Uint8Array(declared);
        const length = inflateExact(zip, directory.entries.get(name), declared, out);
        yield [name, length === null ? null : out.subarray(0, length)];
    }
}

/** One entry at its declared size, or null when the archive does not yield it. */
export function readPackageEntry(zip: Uint8Array, name: string, declaredSize: number): Uint8Array | null {
    for (const [, bytes] of readPackageEntries(zip, new Map([[name, declaredSize]]))) return bytes;
    return null;
}
