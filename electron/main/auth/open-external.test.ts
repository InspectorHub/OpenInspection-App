import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from './open-external.ts';

describe('external URL allowlist', () => {
  it('allows https and only allows http in unpackaged builds', () => {
    expect(isAllowedExternalUrl('https://example.test/path', { packaged: true })).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:8787', { packaged: false })).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:8787', { packaged: true })).toBe(false);
  });

  it.each([
    'ms-msdt:/id PCWDiagnostic',
    'file:///C:/Windows/system.ini',
    'javascript:alert(1)',
    '\\\\server\\share\\file',
    'https://user:pw@example.test/',
    `https://example.test/${'x'.repeat(2040)}`,
    'https://example.test/a\nb',
  ])('rejects unsafe external URL %s', (url) => {
    expect(isAllowedExternalUrl(url, { packaged: false })).toBe(false);
  });
});
