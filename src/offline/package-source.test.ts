import { IMPORT_LIMIT_CEILINGS } from '@inspectorhub/offline-package';
import { describe, expect, it, vi } from 'vitest';
import { makePackage } from './test-support/import-fixtures';
import { ACCEPT_PACKAGE_FILES, readPackageFile, type PickedFile } from './package-source';

function fileOf(bytes: Uint8Array, over: Partial<PickedFile> = {}): PickedFile & { arrayBuffer: ReturnType<typeof vi.fn> } {
  const arrayBuffer = vi.fn(() => Promise.resolve(bytes.slice().buffer));
  return { name: 'export.zip', size: bytes.byteLength, ...over, arrayBuffer } as PickedFile & { arrayBuffer: ReturnType<typeof vi.fn> };
}

describe('choosing a package file', () => {
  it('accepts zip files by extension and by the two media types Android and Windows report', () => {
    expect(ACCEPT_PACKAGE_FILES).toBe('.zip,application/zip,application/x-zip-compressed');
  });

  it('reads a valid package and returns its summary, as the shared package reads it', async () => {
    const made = makePackage({ inspections: 3, photos: { 0: 1 }, updates: { 1: 2 } });
    const result = await readPackageFile(fileOf(made.zip));
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.summary.counts).toEqual({ inspections: 3, writes: 2, photos: 1 });
    expect(result.bytes).toEqual(made.zip);
    expect(result.fileName).toBe('export.zip');
  });

  it('a file over the ceiling is refused before it is read into memory', async () => {
    const file = fileOf(new Uint8Array(8), { size: IMPORT_LIMIT_CEILINGS.compressedBytes + 1 });
    const result = await readPackageFile(file);
    expect(result).toMatchObject({ kind: 'refused' });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    if (result.kind === 'refused') expect(result.message).toMatch(/over the 24(\.0)? MiB limit/);
  });

  it('control: a file exactly at the ceiling is read', async () => {
    const made = makePackage({ inspections: 1 });
    const file = fileOf(made.zip, { size: IMPORT_LIMIT_CEILINGS.compressedBytes });
    const result = await readPackageFile(file);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('ready');
  });

  it('an empty file is refused without being read', async () => {
    const file = fileOf(new Uint8Array(0));
    const result = await readPackageFile(file);
    expect(result).toMatchObject({ kind: 'refused', message: expect.stringMatching(/empty/) });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('something that is not a package is refused with a friendly message, not thrown', async () => {
    const result = await readPackageFile(fileOf(new TextEncoder().encode('this is not a zip archive at all'), { name: 'notes.txt' }));
    expect(result).toMatchObject({ kind: 'refused', message: expect.stringMatching(/not a valid InspectorHub package/) });
  });

  it('a zip that is not a package (no manifest) is refused the same way', async () => {
    const { zipSync } = await import('fflate');
    const result = await readPackageFile(fileOf(zipSync({ 'hello.txt': new TextEncoder().encode('hi') })));
    expect(result).toMatchObject({ kind: 'refused', message: expect.stringMatching(/not a valid InspectorHub package/) });
  });

  it('a file the system cannot read is a different message from a bad package', async () => {
    const file = { name: 'x.zip', size: 10, arrayBuffer: () => Promise.reject(new Error('content:// permission denied')) };
    const result = await readPackageFile(file);
    expect(result).toMatchObject({ kind: 'refused', message: expect.stringMatching(/could not be read/) });
    if (result.kind === 'refused') expect(result.message).not.toMatch(/permission denied|content:/);
  });
});
