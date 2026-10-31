import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import type { UploadTransport } from './uploader-host.ts';

function safeFilename(value: string): string {
  const leaf = basename(value).replace(/[\r\n\0"\\]/g, '_').slice(0, 180);
  return leaf || 'upload.bin';
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
}

export function createUploadTransport(): UploadTransport {
  return {
    send(input) {
      return new Promise((resolve, reject) => {
        let url: URL;
        try { url = new URL(input.url); } catch { reject(new Error('invalid upload url')); return; }
        const boundary = `----oi-${randomUUID()}`;
        const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${input.fileField}"; filename="${safeFilename(input.fileName)}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`, 'utf8');
        const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const contentLength = prefix.byteLength + input.file.size + suffix.byteLength;
        const headers = { ...input.headers, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(contentLength) };
        const sendRequest = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
        if (sendRequest === null) { reject(new Error('unsupported upload protocol')); return; }
        const req = sendRequest(url, { method: 'POST', headers });
        let settled = false;
        const finish = (error?: unknown, statusCode?: number): void => {
          if (settled) return;
          settled = true;
          input.signal.removeEventListener('abort', abort);
          if (error !== undefined) reject(error);
          else resolve({ statusCode: statusCode ?? 0 });
        };
        const abort = (): void => { req.destroy(abortError()); };
        if (input.signal.aborted) { req.destroy(abortError()); }
        else input.signal.addEventListener('abort', abort, { once: true });
        req.on('response', (response) => {
          response.resume();
          response.once('end', () => finish(undefined, response.statusCode));
          response.once('error', (error) => finish(error));
        });
        req.once('error', (error) => finish(error));
        const write = async (chunk: Buffer): Promise<void> => {
          if (input.signal.aborted) throw abortError();
          if (req.destroyed) throw abortError();
          if (!req.write(chunk)) await new Promise<void>((resolveDrain, rejectDrain) => {
            const onDrain = (): void => { cleanup(); resolveDrain(); };
            const onError = (error: Error): void => { cleanup(); rejectDrain(error); };
            const onAbort = (): void => { cleanup(); rejectDrain(abortError()); };
            const cleanup = (): void => { req.off('drain', onDrain); req.off('error', onError); input.signal.removeEventListener('abort', onAbort); };
            req.once('drain', onDrain); req.once('error', onError); input.signal.addEventListener('abort', onAbort, { once: true });
          });
        };
        void (async () => {
          let sent = 0;
          await write(prefix); sent += prefix.byteLength; input.onProgress(sent, contentLength);
          for await (const chunk of createReadStream(input.file.path)) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            await write(bytes); sent += bytes.byteLength; input.onProgress(Math.min(sent, contentLength), contentLength);
          }
          await write(suffix); sent += suffix.byteLength; input.onProgress(sent, contentLength);
          req.end();
        })().catch((error: unknown) => {
          req.destroy(error instanceof Error ? error : new Error('upload failed'));
          finish(error);
        });
      });
    },
  };
}
