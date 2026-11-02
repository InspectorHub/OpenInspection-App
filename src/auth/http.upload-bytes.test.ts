import { describe, expect, it } from 'vitest';
import { createHttp, type FetchLike } from './http';

const URL_ = 'https://oi.example.test/api/client/import';

/** Every byte value from 0x80 up: what a text channel corrupts. */
const HIGH_BYTES = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);

/** A server that echoes what it received, byte for byte, and records the request init. */
function echo(): { fetch: FetchLike; inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  const fetch: FetchLike = async (_input, init) => {
    inits.push(init);
    const received = new Uint8Array(await new Response(init.body).arrayBuffer());
    return new Response(received, { status: 200 });
  };
  return { fetch, inits };
}

describe('http wrapper: byte request bodies', () => {
  it('sends the exact bytes, including 0x80-0xFF, and the server sees them unchanged', async () => {
    const server = echo();
    const res = await createHttp({ fetch: server.fetch }).request({ url: URL_, method: 'POST', bodyBytes: HIGH_BYTES, binary: true, maxBytes: 1024 });
    expect(res.bytes).toEqual(HIGH_BYTES);
  });

  it('control: the same bytes through the text channel come back corrupted', async () => {
    const server = echo();
    const asText = new TextDecoder('utf-8').decode(HIGH_BYTES);
    const res = await createHttp({ fetch: server.fetch }).request({ url: URL_, method: 'POST', body: asText, binary: true, maxBytes: 1024 });
    expect(res.bytes).not.toEqual(HIGH_BYTES);
  });

  it('a byte body carries no hand-written Content-Length (the platform sets it) and keeps the caller content type', async () => {
    const server = echo();
    await createHttp({ fetch: server.fetch }).request({ url: URL_, method: 'POST', headers: { 'Content-Type': 'application/zip' }, bodyBytes: HIGH_BYTES });
    const headers = server.inits[0]?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/zip');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-length');
  });

  it('a request without bodyBytes still sends its text body as before (positive control)', async () => {
    const server = echo();
    await createHttp({ fetch: server.fetch }).request({ url: URL_, method: 'POST', body: '{"a":1}' });
    expect(server.inits[0]?.body).toBe('{"a":1}');
  });

  it('a redirect is still a failure for a byte upload', async () => {
    const http = createHttp({ fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })) });
    await expect(http.request({ url: URL_, method: 'POST', bodyBytes: HIGH_BYTES })).rejects.toMatchObject({ code: 'server_redirected' });
  });
});
