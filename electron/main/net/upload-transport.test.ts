import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUploadTransport } from './upload-transport.ts';

describe('upload transport loopback capture', () => {
  let dir = '';
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
    server = undefined;
  });

  it.each([1024, 10 * 1024 * 1024, 64 * 1024 * 1024])('sends %i bytes with exact multipart Content-Length and no chunked encoding', async (size) => {
    dir = await mkdtemp(join(tmpdir(), 'oi-upload-'));
    const file = join(dir, 'capture.bin');
    const source = Buffer.alloc(size, 0x5a);
    await writeFile(file, source);
    const captured = new Promise<{ headers: IncomingMessage['headers']; body: Buffer }>((resolve) => {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          if (request.headers['content-length'] === undefined) response.writeHead(411).end();
          else response.writeHead(201).end();
          resolve({ headers: request.headers, body });
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('no loopback address');
    const progress: Array<[number, number]> = [];
    const response = await createUploadTransport().send({
      url: `http://127.0.0.1:${address.port}/upload`,
      headers: { 'x-client-platform': 'windows' },
      fileField: 'file',
      fileName: 'capture.bin',
      mimeType: 'application/octet-stream',
      file: { path: file, size },
      signal: new AbortController().signal,
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    const request = await captured;
    const boundary = /boundary=([^;]+)/.exec(String(request.headers['content-type']))?.[1];
    expect(response.statusCode).toBe(201);
    expect(request.headers['content-length']).toBe(String(request.body.byteLength));
    expect(request.headers['transfer-encoding']).toBeUndefined();
    expect(boundary).toBeTruthy();
    const fileStart = request.body.indexOf(Buffer.from('\r\n\r\n')) + 4;
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    expect(request.body.subarray(request.body.length - footer.length)).toEqual(footer);
    const fileBytes = request.body.subarray(fileStart, request.body.length - footer.length);
    expect(fileBytes.byteLength).toBe(source.byteLength);
    expect(Buffer.compare(fileBytes, source)).toBe(0);
    expect(createHash('sha256').update(fileBytes).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
  });

  it('returns every HTTP response as a status instead of treating 503 as a transport failure', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oi-upload-'));
    const file = join(dir, 'tiny.bin');
    await writeFile(file, Buffer.from([1, 2, 3]));
    server = createServer((_request, response) => response.writeHead(503).end());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no loopback address');
    await expect(createUploadTransport().send({ url: `http://127.0.0.1:${address.port}/`, headers: {}, fileField: 'file', fileName: 'a.bin', mimeType: 'application/octet-stream', file: { path: file, size: 3 }, signal: new AbortController().signal, onProgress: () => undefined })).resolves.toEqual({ statusCode: 503 });
  });

  it('aborts an in-flight request promptly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oi-upload-'));
    const file = join(dir, 'large.bin');
    await writeFile(file, Buffer.alloc(1024 * 1024));
    server = createServer((_request, _response) => undefined);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no loopback address');
    const controller = new AbortController();
    const send = createUploadTransport().send({ url: `http://127.0.0.1:${address.port}/`, headers: {}, fileField: 'file', fileName: 'a.bin', mimeType: 'application/octet-stream', file: { path: file, size: 1024 * 1024 }, signal: controller.signal, onProgress: () => undefined });
    controller.abort();
    await expect(send).rejects.toMatchObject({ code: 'ABORT_ERR' });
  });
});
