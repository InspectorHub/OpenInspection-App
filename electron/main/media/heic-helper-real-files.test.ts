import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// These tests run the real Windows helper executable on real files. They need a Windows host, a built helper
// (`npm run build:heic-helper`) and the Microsoft HEIF and HEVC codecs. The CI job runs vitest before it builds the
// helper, so there they are skipped; the Windows build runs them after `build:heic-helper`.
const exePath = resolve('dist-electron/native/win-heic-helper.exe');
const sample = (name: string) => resolve('src/media/heic/fixtures', name);
const hdrSample = resolve('e2e-electron/fixtures/third-party/apple-hdr-heic/hdr-sample.heic');
// Optional extra photos (for example the libheif examples) can be supplied by a developer; they are not stored here.
const corpusDirectory = process.env.OI_HEIC_CORPUS_DIR;

interface HelperRun { status: number | null; jpeg: Buffer }

function runHelper(file: string, maxLongEdge = 4096): HelperRun {
  const run = spawnSync(exePath, ['--max-long-edge', String(maxLongEdge)], { input: readFileSync(file), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: run.status, jpeg: run.stdout };
}

function jpegInfo(jpeg: Buffer): { width: number; height: number; markers: number[] } {
  let width = 0;
  let height = 0;
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) { offset += 1; continue; }
    const marker = jpeg[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) break;
    markers.push(marker);
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && width === 0) {
      height = jpeg.readUInt16BE(offset + 5);
      width = jpeg.readUInt16BE(offset + 7);
    }
    if (marker === 0xda) break;
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return { width, height, markers };
}

const helperUsable = process.platform === 'win32' && existsSync(exePath)
  && spawnSync(exePath, ['--max-long-edge', '64'], { input: readFileSync(sample('fixture-64x48.heic')), windowsHide: true }).status === 0;

function expectDecodes(file: string, size: { width: number; height: number }): void {
  const run = runHelper(file);
  expect(run.status).toBe(0);
  expect(run.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const info = jpegInfo(run.jpeg);
  expect({ width: info.width, height: info.height }).toEqual(size);
  // APP1 carries EXIF and XMP, APP2 carries ICC profiles, APP13 carries IPTC, COM carries comments.
  expect(info.markers.filter((marker) => marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe)).toEqual([]);
}

describe.runIf(helperUsable)('the Windows HEIC helper on real files', () => {
  it('decodes a real iPhone HDR photo that carries a gain-map auxiliary image and a shared irot property', () => {
    expectDecodes(hdrSample, { width: 1512, height: 850 });
  });

  it('applies the irot turn of the real photo layout, where one irot property is shared by two items', () => {
    const bytes = readFileSync(hdrSample);
    const property = bytes.indexOf(Buffer.from('irot'));
    expect(property).toBeGreaterThan(0);
    expect(bytes[property + 4]).toBe(0);
    bytes[property + 4] = 1; // A quarter turn swaps the output width and height.
    const directory = mkdtempSync(join(tmpdir(), 'oi-heic-irot-'));
    try {
      const turned = join(directory, 'turned.heic');
      writeFileSync(turned, bytes);
      expectDecodes(turned, { width: 850, height: 1512 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps decoding the synthetic fixtures with and without an irot property', () => {
    expectDecodes(sample('fixture-64x48.heic'), { width: 64, height: 48 });
    expectDecodes(sample('fixture-rot90.heic'), { width: 48, height: 64 });
    expectDecodes(sample('fixture-grid.heic'), { width: 128, height: 96 });
  });

  it.runIf(corpusDirectory !== undefined && existsSync(resolve(corpusDirectory, 'example.heic')))('decodes the libheif example photo', () => {
    expectDecodes(resolve(corpusDirectory ?? '', 'example.heic'), { width: 1280, height: 854 });
  });

  it.runIf(corpusDirectory !== undefined && existsSync(resolve(corpusDirectory, 'rainbow-451x461.heic')))('decodes the libheif rainbow image', () => {
    expectDecodes(resolve(corpusDirectory ?? '', 'rainbow-451x461.heic'), { width: 451, height: 461 });
  });
});

// The helper rewrites the meta box of a file with an irot property, so a fixture whose iloc points at the wrong bytes
// would only decode by accident. This runs on every host and keeps the irot fixture honest.
describe('the irot fixture layout', () => {
  it('has an iloc extent that lies inside the mdat payload', () => {
    const bytes = readFileSync(sample('fixture-rot90.heic'));
    const boxes = new Map<string, { start: number; size: number }>();
    for (let offset = 0; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      boxes.set(bytes.toString('latin1', offset + 4, offset + 8), { start: offset, size });
      offset += size;
    }
    const mdat = boxes.get('mdat');
    const meta = boxes.get('meta');
    expect(mdat).toBeDefined();
    expect(meta).toBeDefined();
    const iloc = bytes.indexOf(Buffer.from('iloc'), meta?.start);
    expect(bytes[iloc + 4]).toBe(0); // Version 0, with four-byte offsets and lengths and no base offset.
    expect(bytes.readUInt16BE(iloc + 8)).toBe(0x4400);
    expect(bytes.readUInt16BE(iloc + 10)).toBe(1);
    const extentOffset = bytes.readUInt32BE(iloc + 18);
    const extentLength = bytes.readUInt32BE(iloc + 22);
    expect(extentOffset).toBe((mdat?.start ?? 0) + 8);
    expect(extentOffset + extentLength).toBeLessThanOrEqual((mdat?.start ?? 0) + (mdat?.size ?? 0));
  });
});
