import { describe, expect, it } from 'vitest';
import { AuthError } from './errors';
import { createHttp } from './http';

const URL_ = 'https://oi.example.test/api/inspections/i1/photo?key=k';
const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

const answer = (body: BodyInit | null, init: ResponseInit = {}) => () => Promise.resolve(new Response(body, { status: 200, ...init }));

describe('http wrapper: binary answers', () => {
  it('a binary request returns the exact bytes, no text and no json', async () => {
    const res = await createHttp({ fetch: answer(BYTES, { headers: { 'content-type': 'image/jpeg' } }) }).request({ url: URL_, method: 'GET', binary: true, maxBytes: 1024 });
    expect(res.bytes).toEqual(BYTES);
    expect(res.text).toBe('');
    expect(res.json).toBeUndefined();
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('control: a text request has no bytes', async () => {
    const res = await createHttp({ fetch: answer('{"a":1}') }).request({ url: URL_, method: 'GET' });
    expect(res.bytes).toBeUndefined();
    expect(res.json).toEqual({ a: 1 });
  });

  it('an answer over the cap is refused whether the size is declared or only counted', async () => {
    const declared = createHttp({ fetch: answer(BYTES, { headers: { 'content-length': '12' } }) }).request({ url: URL_, method: 'GET', binary: true, maxBytes: 8 });
    await expect(declared).rejects.toBeInstanceOf(AuthError);
    const counted = createHttp({ fetch: answer(new ReadableStream({ start: (c) => (c.enqueue(BYTES.subarray(0, 6)), c.enqueue(BYTES.subarray(6)), c.close()) })) }).request({ url: URL_, method: 'GET', binary: true, maxBytes: 8 });
    await expect(counted).rejects.toBeInstanceOf(AuthError);
    // Control: the same answer under a bigger cap passes, in one piece.
    const fits = await createHttp({ fetch: answer(new ReadableStream({ start: (c) => (c.enqueue(BYTES.subarray(0, 6)), c.enqueue(BYTES.subarray(6)), c.close()) })) }).request({ url: URL_, method: 'GET', binary: true, maxBytes: 64 });
    expect(fits.bytes).toEqual(BYTES);
  });

  it('a redirect is still a failure for a binary request', async () => {
    const redirected = createHttp({ fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })) }).request({ url: URL_, method: 'GET', binary: true });
    await expect(redirected).rejects.toMatchObject({ code: 'server_redirected' });
  });
});
