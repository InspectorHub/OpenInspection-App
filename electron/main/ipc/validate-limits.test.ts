import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, validators } from './validate.ts';

const MIB = 1024 * 1024;
const bytes = (length: number): Uint8Array => new Uint8Array(length);
const refuses = (call: () => unknown): void => expect(call).toThrow(InvalidArgumentError);

const uploadOptions = {
  filePath: 'file:///C:/media/a.jpg',
  serverUrl: 'https://engine.example/upload',
  method: 'POST',
  uploadType: 'multipart',
  fileField: 'file',
  mimeType: 'image/jpeg',
  maxRetries: 3,
  headers: { Authorization: 'Bearer x' },
  notificationTitle: 'Uploading',
};

describe('ceilings, at the limit and one over', () => {
  it('db sql text: 100,000 characters pass, 100,001 do not', () => {
    expect(() => validators.db.execute(['x'.repeat(100_000)])).not.toThrow();
    refuses(() => validators.db.execute(['x'.repeat(100_001)]));
    expect(() => validators.db.query(['x'.repeat(100_000)])).not.toThrow();
    refuses(() => validators.db.query(['x'.repeat(100_001)]));
  });

  it('db params: 1000 pass, 1001 do not', () => {
    expect(() => validators.db.run(['INSERT', new Array<number>(1000).fill(1)])).not.toThrow();
    refuses(() => validators.db.run(['INSERT', new Array<number>(1001).fill(1)]));
  });

  it('a string param has its own ceiling of 1 MiB, not the sql one', () => {
    expect(() => validators.db.run(['INSERT', ['y'.repeat(100_001)]])).not.toThrow();
    expect(() => validators.db.run(['INSERT', ['y'.repeat(MIB)]])).not.toThrow();
    refuses(() => validators.db.run(['INSERT', ['y'.repeat(MIB + 1)]]));
  });

  it('a Uint8Array param is capped at 16 MiB', () => {
    expect(() => validators.db.run(['INSERT', [bytes(16 * MIB)]])).not.toThrow();
    refuses(() => validators.db.run(['INSERT', [bytes(16 * MIB + 1)]]));
  });

  it('files:write and files:stream-append: 16 MiB pass, 16 MiB + 1 do not', () => {
    expect(() => validators.files.write(['a.jpg', bytes(16 * MIB)])).not.toThrow();
    refuses(() => validators.files.write(['a.jpg', bytes(16 * MIB + 1)]));
    expect(() => validators.files.streamAppend(['h', bytes(16 * MIB)])).not.toThrow();
    refuses(() => validators.files.streamAppend(['h', bytes(16 * MIB + 1)]));
  });
});

describe('hostile shapes', () => {
  it('refuses an own __proto__ key in an options object', () => {
    const options = JSON.parse(JSON.stringify(uploadOptions)) as Record<string, unknown>;
    Object.defineProperty(options, '__proto__', { value: { polluted: true }, enumerable: true });
    refuses(() => validators.uploader.start([options]));
    const request = { bytes: new ArrayBuffer(8), maxLongEdge: 2560 };
    Object.defineProperty(request, '__proto__', { value: {}, enumerable: true });
    refuses(() => validators.media.decodeHeic([request]));
  });

  it('refuses Infinity and NaN as a param, an array hole, and an over-ceiling Uint8Array param', () => {
    refuses(() => validators.db.query(['SELECT ?', [Infinity]]));
    refuses(() => validators.db.query(['SELECT ?', [-Infinity]]));
    refuses(() => validators.db.query(['SELECT ?', [1, , 3]]));
    refuses(() => validators.db.query(['SELECT ?', [bytes(16 * MIB + 1)]]));
    expect(() => validators.db.query(['SELECT ?', [1, 2, 3]])).not.toThrow();
  });
});

describe('maxLongEdge', () => {
  const decode = (maxLongEdge: number, keepOriginal?: { maxBytes: number }) =>
    validators.media.decodeHeic([{ bytes: new ArrayBuffer(8), maxLongEdge, ...(keepOriginal === undefined ? {} : { keepOriginal }) }]);

  it('is an integer from 1 to 16384', () => {
    for (const ok of [1, 2560, 16384]) expect(() => decode(ok)).not.toThrow();
    for (const bad of [1e-300, 0.5, 2560.5, 16385, 1e308]) refuses(() => decode(bad));
  });

  it('may be Infinity only together with keepOriginal, and the other values stay bounded then too', () => {
    expect(() => decode(Infinity, { maxBytes: 1024 })).not.toThrow();
    refuses(() => decode(Infinity));
    refuses(() => decode(1e308, { maxBytes: 1024 }));
    refuses(() => decode(1e-300, { maxBytes: 1024 }));
  });
});

describe('upload headers', () => {
  const start = (headers: Record<string, string>) => validators.uploader.start([{ ...uploadOptions, headers }]);

  it('accepts ordinary headers (control)', () => {
    expect(() => start({ Authorization: 'Bearer abc', 'X-Client-Version': '1.2.3' })).not.toThrow();
  });

  it.each([
    ['a CR in a value', { A: 'x\r\nInjected: 1' }],
    ['an LF in a value', { A: 'x\ny' }],
    ['a NUL in a value', { A: 'x\u0000y' }],
    ['a DEL in a value', { A: 'x\u007fy' }],
    ['a CR in a name', { 'A\r\nB': 'x' }],
    ['a space in a name', { 'A B': 'x' }],
    ['a colon in a name', { 'A:B': 'x' }],
    ['the Host name', { Host: 'evil.example' }],
    ['Content-Length in any case', { 'cOnTeNt-LeNgTh': '1' }],
    ['Transfer-Encoding', { 'Transfer-Encoding': 'chunked' }],
  ])('refuses %s', (_name, headers) => {
    refuses(() => start(headers));
  });

  it('refuses an own __proto__ header name', () => {
    const headers = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    refuses(() => start(headers));
  });

  it('returns the headers as a prototype-free copy', () => {
    const [options] = validators.uploader.start([{ ...uploadOptions, headers: { A: 'b' } }]);
    expect(Object.getPrototypeOf(options.headers)).toBeNull();
    expect({ ...options.headers }).toEqual({ A: 'b' });
  });
});
