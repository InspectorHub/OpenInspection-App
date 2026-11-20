import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
    FORMAT_VERSION,
    ROOT_VOLUME_NAME,
    dataFileName,
    generateChecksums,
    serializeManifest,
    sha256Hex,
    type ChecksumEntry,
    type Manifest,
} from '@inspectorhub/data-package';
import { verifyPackage } from './preflight';

async function digest(text: string): Promise<string> {
    return sha256Hex(strToU8(text));
}

/** Build a minimal, self-consistent package: root zip + one data volume zip. */
async function makePackage(opts: { tamperData?: boolean } = {}) {
    const dataPath = dataFileName('contacts', 1); // "data/contacts.ndjson"
    const dataText = '{"id":"c1","tenant_id":"src","name":"A"}\n';
    const dataBytes = strToU8(dataText);
    const mediaIndexText = '';
    const manifest: Manifest = {
        formatVersion: FORMAT_VERSION,
        schemaVersion: '0013_import_id_map',
        columnFingerprint: 'a'.repeat(64),
        engineVersion: '2.6.0',
        packageId: '123e4567-e89b-12d3-a456-426614174000',
        exportedAt: '2026-01-01T00:00:00.000Z',
        sourceMode: 'standalone',
        sourceTenantId: 'src-tenant',
        sourceHost: null,
        encryption: null,
        counts: { contacts: 1 },
        media: {
            count: 0,
            index: { path: 'media/index.ndjson', bytes: 0, sha256: await digest(mediaIndexText) },
        },
        files: [{ path: dataPath, volume: ROOT_VOLUME_NAME, rows: 1, bytes: dataBytes.length, sha256: await digest(dataText) }],
        volumes: [],
        excluded: [],
    };
    const manifestBytes = serializeManifest(manifest);
    // checksums.sha256 lists the root volume's data files + the media index,
    // exactly as assertRootChecksums expects (manifest.json is not listed).
    const checksumEntries: ChecksumEntry[] = [
        { path: 'media/index.ndjson', sha256: manifest.media.index.sha256 },
        ...manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    ];
    const checksumsBytes = strToU8(generateChecksums(checksumEntries));
    const root = zipSync({
        'manifest.json': manifestBytes,
        'checksums.sha256': checksumsBytes,
        'media/index.ndjson': strToU8(mediaIndexText),
        [dataPath]: opts.tamperData ? strToU8('{"id":"TAMPERED"}\n') : dataBytes,
    });
    return { root, manifest };
}

describe('verifyPackage (local preflight)', () => {
    it('accepts a self-consistent package and returns the preview', async () => {
        const { root, manifest } = await makePackage();
        const result = verifyPackage(root);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.preview.counts).toEqual({ contacts: 1 });
            expect(result.preview.mediaCount).toBe(0);
            expect(result.preview.manifest.packageId).toBe(manifest.packageId);
        }
    });

    it('rejects a package whose format version is newer than importer', async () => {
        // serializeManifest caps the field, so build the newer manifest JSON by
        // hand to simulate a package from a future exporter.
        const { root: good, manifest } = await makePackage();
        const newer = { ...manifest, formatVersion: FORMAT_VERSION + 1 };
        const newerBytes = strToU8(JSON.stringify(newer, null, 2) + '\n');
        const entries: Record<string, Uint8Array> = {};
        // Rebuild root zip swapping only manifest.json (checked by filename).
        const { unzipSync } = await import('fflate');
        const parsed = unzipSync(good);
        for (const [name, bytes] of Object.entries(parsed)) entries[name] = bytes;
        entries['manifest.json'] = newerBytes;
        const root = zipSync(entries);
        const result = verifyPackage(root);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problem).toBe('format_too_new');
    });

    it('rejects a missing manifest', async () => {
        const root = zipSync({ 'checksums.sha256': strToU8('') });
        const result = verifyPackage(root);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(['manifest_missing', 'checksums_invalid', 'unsafe_entry']).toContain(result.problem);
    });

    it('rejects tampered data bytes against the manifest digest', async () => {
        const { root } = await makePackage({ tamperData: true });
        const result = verifyPackage(root);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(['checksum_mismatch', 'volume_corrupt']).toContain(result.problem);
    });

    it('rejects a non-zip input', () => {
        const result = verifyPackage(strToU8('not a zip'));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problem).toBe('not_a_zip');
    });
});
