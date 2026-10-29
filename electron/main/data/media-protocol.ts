import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

export interface MediaProtocolDeps {
  mediaRoot: string;
  fs?: Pick<typeof import('node:fs/promises'), 'open' | 'realpath' | 'stat'>;
  fetchFile(file: FileHandle, init: { headers: Headers; method: 'GET' | 'HEAD' }): Promise<Response>;
}

function fileBody(file: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position > end) { controller.close(); return; }
      try {
        const buffer = new Uint8Array(Math.min(64 * 1024, end - position + 1));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) { controller.close(); return; }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) { controller.error(error); }
    },
  });
}

export async function createMediaFileResponse(file: FileHandle, init: { headers: Headers; method: 'GET' | 'HEAD' }): Promise<Response> {
  const stat = await file.stat();
  if (init.method === 'HEAD') {
    return new Response(null, { headers: { 'Content-Length': String(stat.size) } });
  }
  const range = init.headers.get('range');
  if (range === null) return new Response(fileBody(file, 0, stat.size - 1), { headers: { 'Content-Length': String(stat.size) } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (match[1] === '' && (!match[2] || Number(match[2]) <= 0))) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  }
  const start = match[1] === '' ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? stat.size - 1 : Math.min(stat.size - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
  }
  return new Response(fileBody(file, start, end), { status: 206, headers: { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` } });
}

async function transferHandleToResponse(response: Response, file: FileHandle): Promise<Response> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= file.close().catch(() => undefined);
  const body = response.body;
  if (body === null) {
    await close();
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { await close(); }
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createMediaProtocolHandler(deps: MediaProtocolDeps): (req: Request) => Promise<Response> {
  const root = resolve(deps.mediaRoot);
  const fs = deps.fs ?? { open, realpath, stat };
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (/%2e|(?:^|\/)\.\.(?:\/|$)/i.test(req.url)) return new Response(null, { status: 400 });
    let url: URL;
    try { url = new URL(req.url); } catch { return new Response(null, { status: 400 }); }
    if (url.protocol !== 'oi-media:' || url.hostname !== 'media') return new Response(null, { status: 404 });
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname.slice(1)); } catch { return new Response(null, { status: 400 }); }
    if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || part.includes(':'))) return new Response(null, { status: 400 });
    const path = join(root, ...decoded.split('/'));
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return new Response(null, { status: 400 });
    const type = MIME[extname(path).toLowerCase()];
    if (!type) return new Response(null, { status: 404 });
    const realRoot = await fs.realpath(root).catch(() => root);
    const headers = new Headers();
    const range = req.headers.get('range');
    if (range !== null) headers.set('range', range);
    let file: FileHandle | undefined;
    let ownsFile = false;
    try {
      file = await fs.open(path, 'r');
      ownsFile = true;
      const [openedStat, namedStat, openedPath] = await Promise.all([file.stat(), fs.stat(path), fs.realpath(path)]);
      const openedRel = relative(realRoot, openedPath);
      if (!openedStat.isFile() || !namedStat.isFile() || openedStat.dev !== namedStat.dev || openedStat.ino !== namedStat.ino || isAbsolute(openedRel) || openedRel === '..' || openedRel.startsWith(`..${sep}`)) {
        return new Response(null, { status: 404 });
      }
      const source = await deps.fetchFile(file, { headers, method: req.method });
      const outHeaders = new Headers(source.headers);
      outHeaders.set('Content-Type', type);
      outHeaders.set('X-Content-Type-Options', 'nosniff');
      outHeaders.set('Cache-Control', 'no-store');
      const response = new Response(req.method === 'HEAD' ? null : source.body, { status: source.status, statusText: source.statusText, headers: outHeaders });
      if (req.method === 'HEAD') {
        await source.body?.cancel();
        await file.close();
        ownsFile = false;
        return response;
      }
      const transferred = await transferHandleToResponse(response, file);
      ownsFile = false;
      return transferred;
    } catch {
      return new Response(null, { status: 404, headers: { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
    } finally {
      if (ownsFile) await file?.close().catch(() => undefined);
    }
  };
}
