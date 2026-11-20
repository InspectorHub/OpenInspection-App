/**
 * Local package verification before any byte is uploaded (A-5). The desktop
 * machine opens the package, so it — not the server — must reject hostile or
 * malformed input first: format version, manifest shape, root checksums, entry
 * names and byte digests. Only after this passes does the importer send a
 * preflight request to the engine and start applying batches.
 *
 * All format rules come from @inspectorhub/data-package — the same code the
 * exporter used — so the two sides cannot drift. This module never uploads and
 * never learns a tenant, a token or any secret.
 */
import {
    FORMAT_VERSION,
    MAX_CHECKSUMS_BYTES,
    MAX_MANIFEST_BYTES,
    Sha256Js,
    assertNoDuplicateEntryNames,
    assertRootChecksums,
    entryNameProblem,
    parseChecksums,
    parseManifest,
    type Manifest,
} from '@inspectorhub/data-package';
import { listPackage, readPackageEntry } from './zip-reader';

export type VerifyProblem =
    | 'not_a_zip'
    | 'unsafe_entry'
    | 'manifest_missing'
    | 'manifest_invalid'
    | 'format_too_new'
    | 'checksums_missing'
    | 'checksums_invalid'
    | 'checksum_mismatch'
    | 'media_index_missing'
    | 'volume_missing'
    | 'volume_corrupt';

export interface LocalPreview {
    readonly manifest: Manifest;
    /** Table -> row count from the manifest (validated by parseManifest). */
    readonly counts: Record<string, number>;
    readonly excluded: Manifest['excluded'];
    /** Number of volumes and media objects, for the UI estimate. */
    readonly volumes: number;
    readonly mediaCount: number;
}

export type VerifyResult =
    | { ok: true; preview: LocalPreview }
    | { ok: false; problem: VerifyProblem; detail?: string };

const bad = (problem: VerifyProblem, detail?: string): VerifyResult => ({ ok: false, problem, detail });

/** Synchronous digest of an in-memory buffer via the package's pure-JS hasher. */
function digest(bytes: Uint8Array): string {
    const h = new Sha256Js();
    h.update(bytes);
    return h.digestHex();
}

/** Every entry name must be safe and unique. Returns an error string or null. */
function safeEntryNames(names: Iterable<string>): string | null {
    for (const name of names) {
        const problem = entryNameProblem(name);
        if (problem) return `unsafe entry: ${name} (${problem})`;
    }
    try {
        assertNoDuplicateEntryNames(names);
    } catch (err) {
        return err instanceof Error ? err.message : 'duplicate entry names';
    }
    return null;
}

/**
 * Verify a package from its root ZIP bytes. Pure and synchronous: no I/O, no
 * network, no writes. `getVolume` supplies the bytes of each separate volume zip
 * by volume name; the root zip is passed directly.
 */
export function verifyPackage(
    rootZip: Uint8Array,
    getVolume: (name: string) => Uint8Array | undefined = () => undefined,
): VerifyResult {
    // 1. Root volume: reject hostile structure and unsafe names before reading.
    const root = listPackage(rootZip, {
        uncompressedBytes: MAX_MANIFEST_BYTES + MAX_CHECKSUMS_BYTES + 16 * 1024 * 1024,
    });
    if (!root.ok) return bad(root.reason.includes('entry') || root.reason.includes('duplicate') ? 'unsafe_entry' : 'not_a_zip', root.reason);
    const unsafe = safeEntryNames(root.entries.keys());
    if (unsafe) return bad('unsafe_entry', unsafe);

    // 2. Manifest. Peek the version first so a newer package gets a clear,
    //    actionable code even though parseManifest also caps the field.
    if (!root.entries.has('manifest.json')) return bad('manifest_missing');
    const manifestBytes = readPackageEntry(rootZip, 'manifest.json', root.entries.get('manifest.json')!);
    if (!manifestBytes) return bad('manifest_missing');
    try {
        const peeked = JSON.parse(new TextDecoder().decode(manifestBytes)) as { formatVersion?: unknown };
        if (typeof peeked.formatVersion === 'number' && peeked.formatVersion > FORMAT_VERSION) {
            return bad('format_too_new', `package v${peeked.formatVersion}, importer v${FORMAT_VERSION}`);
        }
    } catch {
        // parseManifest below produces the precise parse error.
    }
    let manifest: Manifest;
    try {
        manifest = parseManifest(manifestBytes);
    } catch (err) {
        return bad('manifest_invalid', err instanceof Error ? err.message : undefined);
    }

    // 3. Root checksums: must list exactly the manifest's files + media index.
    if (!root.entries.has('checksums.sha256')) return bad('checksums_missing');
    const checksumBytes = readPackageEntry(rootZip, 'checksums.sha256', root.entries.get('checksums.sha256')!);
    if (!checksumBytes) return bad('checksums_missing');
    try {
        assertRootChecksums(parseChecksums(checksumBytes), manifest);
    } catch (err) {
        return bad('checksums_invalid', err instanceof Error ? err.message : undefined);
    }

    // 4. The media index and every data file must hash to what the manifest says.
    const mediaIndexPath = manifest.media.index.path;
    if (!root.entries.has(mediaIndexPath)) return bad('media_index_missing');
    const mediaIndexBytes = readPackageEntry(rootZip, mediaIndexPath, root.entries.get(mediaIndexPath)!);
    if (!mediaIndexBytes) return bad('media_index_missing');
    if (digest(mediaIndexBytes) !== manifest.media.index.sha256) return bad('checksum_mismatch', mediaIndexPath);

    // Listed data/esign files always live in the ROOT volume (enforced by the
    // manifest cross-checks); only media volumes are separate zips.
    for (const file of manifest.files) {
        const found = readPackageEntry(rootZip, file.path, file.bytes);
        if (!found) return bad('volume_corrupt', `${file.volume}:${file.path}`);
        if (digest(found) !== file.sha256) return bad('checksum_mismatch', `${file.volume}:${file.path}`);
    }
    // Media volumes are verified here when supplied, so a corrupt/lying media
    // volume is caught before any upload (their internal index is checked by
    // verifyMediaIndex in A-6 against the actual media objects).
    for (const volume of manifest.volumes) {
        const volumeBytes = getVolume(volume.name);
        if (!volumeBytes) return bad('volume_missing', volume.name);
        if (digest(volumeBytes) !== volume.sha256) return bad('checksum_mismatch', volume.name);
    }

    return {
        ok: true,
        preview: {
            manifest,
            counts: manifest.counts,
            excluded: manifest.excluded,
            volumes: manifest.volumes.length,
            mediaCount: manifest.media.count,
        },
    };
}
