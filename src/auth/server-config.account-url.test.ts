import { describe, expect, it } from 'vitest';
import type { Http } from './http';
import { jsonReply } from '../offline/test-support/package-world';
import { fetchCompat } from './server-config';

function http(data: Record<string, unknown>): Http {
  return { request: () => Promise.resolve(jsonReply(200, { success: true, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, ...data } })) } as unknown as Http;
}

describe('the account page of a server', () => {
  it('is absent when the server does not say (nothing is invented)', async () => {
    expect((await fetchCompat(http({}), 'https://oi.example.test', 'android')).accountUrl ?? null).toBeNull();
  });

  it('is kept, normalised, when the server gives an https address', async () => {
    const compat = await fetchCompat(http({ accountUrl: 'https://OI.example.test/account#privacy' }), 'https://oi.example.test', 'android');
    expect(compat.accountUrl).toBe('https://oi.example.test/account#privacy');
  });

  it.each(['http://oi.example.test/account', 'javascript:alert(1)', 'https://user:pw@oi.example.test/account', '', 42])('refuses %j without failing the whole answer', async (value) => {
    const compat = await fetchCompat(http({ accountUrl: value }), 'https://oi.example.test', 'android');
    expect(compat.accountUrl ?? null).toBeNull();
    expect(compat.serverContractVersion).toBe(2);
  });
});
