import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { listPackage, readPackageEntry, readPackageEntries, ZIP_READ_LIMITS } from './zip-reader';

function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
    const data: Record<string, Uint8Array> = {};
    for (const [name, value] of Object.entries(entries)) {
        data[name] = typeof value === 'string' ? strToU8(value) : value;
    }
    return zipSync(data);
}

describe('zip-reader listPackage', () => {
    it('lists a well-formed package with declared sizes', () => {
        const zip = makeZip({ 'manifest.json': '{}', 'data/t1.ndjson': 'a\nb\n' });
        const list = listPackage(zip);
        expect(list.ok).toBe(true);
        if (list.ok) {
            expect(list.entries.get('manifest.json')).toBe(2);
            expect(list.entries.get('data/t1.ndjson')).toBe(4);
        }
    });

    it('rejects a non-zip byte stream', () => {
        const list = listPackage(strToU8('not a zip at all'));
        expect(list.ok).toBe(false);
    });

    it('rejects too many entries', () => {
        const many: Record<string, string> = {};
        for (let i = 0; i < 12; i++) many[`f${i}.txt`] = 'x';
        const list = listPackage(makeZip(many), { entries: 10 });
        expect(list.ok).toBe(false);
        if (!list.ok) expect(list.reason).toMatch(/too many entries/);
    });

    it('rejects a declared-uncompressed total beyond the cap', () => {
        const zip = makeZip({ a: 'a'.repeat(100), b: 'b'.repeat(100) });
        const list = listPackage(zip, { uncompressedBytes: 150 });
        expect(list.ok).toBe(false);
        if (!list.ok) expect(list.reason).toMatch(/too large once unpacked/);
    });

    it('rejects an entry larger than the single-entry cap', () => {
        const zip = makeZip({ a: 'a'.repeat(100) });
        const list = listPackage(zip, { singleEntryBytes: 50 });
        expect(list.ok).toBe(false);
        if (!list.ok) expect(list.reason).toMatch(/entry too large/);
    });

    it('refuses entries whose name fails the caller allow-list', () => {
        const zip = makeZip({ 'manifest.json': '{}', '../evil.txt': 'x' });
        const list = listPackage(zip, {}, (name) => name === 'manifest.json' || !name.includes('..'));
        expect(list.ok).toBe(false);
        if (!list.ok) expect(list.reason).toMatch(/unexpected entry/);
    });

    it('rejects ZIP64 sentinels in the end-of-central-directory', () => {
        const zip = makeZip({ a: 'x' });
        // The central-directory offset field starts at eocd+16; set it to 0xffffffff.
        let eocd = zip.length - 22;
        const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
        while (view.getUint32(eocd, true) !== 0x06054b50 && eocd > 0) eocd--;
        new DataView(zip.buffer, zip.byteOffset, zip.byteLength).setUint32(eocd + 16, 0xffffffff, true);
        const list = listPackage(zip);
        expect(list.ok).toBe(false);
        if (!list.ok) expect(list.reason).toMatch(/ZIP64/);
    });
});

describe('zip-reader entry reads', () => {
    it('reads back exact bytes of a stored/deflated entry', () => {
        const payload = 'hello data package\n';
        const zip = makeZip({ 'data/t1.ndjson': payload });
        const bytes = readPackageEntry(zip, 'data/t1.ndjson', payload.length);
        expect(bytes).not.toBeNull();
        expect(new TextDecoder().decode(bytes!)).toBe(payload);
    });

    it('yields null for an entry that does not inflate to its declared size', () => {
        const zip = makeZip({ a: 'a'.repeat(10) });
        // Ask for 11 bytes when only 10 exist — the bounded inflate must refuse
        // rather than hand back a short buffer.
        const out = [...readPackageEntries(zip, new Map([['a', 11]]))];
        expect(out).toHaveLength(1);
        expect(out[0]![1]).toBeNull();
    });

    it('yields null for a missing entry', () => {
        const zip = makeZip({ a: 'x' });
        expect(readPackageEntry(zip, 'missing', 1)).toBeNull();
    });

    it('respects the single-entry ceiling from the default limits', () => {
        expect(ZIP_READ_LIMITS.maxSingleEntryBytes).toBeLessThan(ZIP_READ_LIMITS.maxUncompressedBytes);
    });
});
