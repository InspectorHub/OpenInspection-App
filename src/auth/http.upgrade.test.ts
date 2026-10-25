import { describe, expect, it, vi } from 'vitest';
import { createHttp, type FetchLike } from './http';

const ORIGIN = 'https://oi.example.test';

function answer(status: number, headers: Record<string, string> = {}): FetchLike {
  return () => Promise.resolve(new Response('{}', { status, headers }));
}

describe('http wrapper: upgrade signals carry the origin they came from', () => {
  it('a header is reported with the origin of the request', async () => {
    const onUpgrade = vi.fn();
    await createHttp({ fetch: answer(200, { 'x-client-upgrade': 'recommended' }), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onUpgrade).toHaveBeenCalledWith('recommended', ORIGIN);
  });

  it('a 426 is reported as required even when the server sent no header, and the answer still comes back', async () => {
    const onUpgrade = vi.fn();
    const res = await createHttp({ fetch: answer(426), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    expect(res.status).toBe(426);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onUpgrade).toHaveBeenCalledWith('required', ORIGIN);
  });

  it('a 426 is reported once, as required, whatever the header says', async () => {
    const onUpgrade = vi.fn();
    await createHttp({ fetch: answer(426, { 'x-client-upgrade': 'recommended' }), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    expect(onUpgrade.mock.calls).toEqual([['required', ORIGIN]]);
  });

  it('control: an ordinary answer without the header reports nothing', async () => {
    const onUpgrade = vi.fn();
    await createHttp({ fetch: answer(200), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    await createHttp({ fetch: answer(500), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it('a listener that throws changes nothing about the request', async () => {
    const onUpgrade = vi.fn(() => {
      throw new Error('listener failed');
    });
    const res = await createHttp({ fetch: answer(426), onUpgrade }).request({ url: `${ORIGIN}/api/x`, method: 'GET' });
    expect(res.status).toBe(426);
    expect(onUpgrade).toHaveBeenCalled();
  });
});
