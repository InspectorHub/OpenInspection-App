import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** The one origin the renderer is served from; the engine allows it as a native-app origin. */
export const APP_ORIGIN = 'https://localhost';

/** Reject wrappers and credentials even when WHATWG reports the same origin. */
export function isAppOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === APP_ORIGIN && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export function buildCsp({ packaged }: { packaged: boolean }): string {
  const loopback = packaged ? '' : ' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*';
  return `default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: oi-media: https:; media-src 'self' blob: oi-media: https:; font-src 'self'; connect-src 'self' https: wss:${loopback}; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

/** Accept an undecoded URL pathname, decode once, then enforce the filesystem boundary. */
export function mapRendererPath(rendererRoot: string, rawPath: string): string | null {
  try {
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /%2f|%5c/i.test(rawPath)) return null;
    const decoded = decodeURIComponent(rawPath);
    if (/[\\:%<>"|?*\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some((part) =>
      part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
    const root = resolve(rendererRoot);
    const target = resolve(root, decoded === '/' ? 'index-electron.html' : decoded.slice(1));
    const child = relative(root, target);
    if (child === '' || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) return null;
    return target;
  } catch {
    return null;
  }
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

export function createHttpsPassthrough(net: { fetch(req: Request, options: { bypassCustomProtocolHandlers: true }): Promise<Response> }): (req: Request) => Promise<Response> {
  return (req) => net.fetch(req, { bypassCustomProtocolHandlers: true });
}

export function createAppOriginHandler(deps: {
  rendererRoot: string;
  readFile(p: string): Promise<Uint8Array>;
  passthrough(req: Request): Promise<Response>;
  packaged: boolean;
}): (req: Request) => Promise<Response> {
  const csp = buildCsp(deps);
  return async (req) => {
    if (!isAppOrigin(req.url)) {
      try { return await deps.passthrough(req); } catch { return new Response(null, { status: 502 }); }
    }
    const headers = { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
    const path = mapRendererPath(deps.rendererRoot, new URL(req.url).pathname);
    if (path === null) return new Response(null, { status: 404, headers });
    try {
      const bytes = await deps.readFile(path);
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' } });
    } catch {
      return new Response(null, { status: 404, headers });
    }
  };
}
