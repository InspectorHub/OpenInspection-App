import { describe, expect, it } from 'vitest';
import { httpsHref } from './https-href';

describe('httpsHref', () => {
  it('returns the normalised address of an https url', () => {
    expect(httpsHref('https://Example.com/app.apk?x=1')).toBe('https://example.com/app.apk?x=1');
  });

  it.each(['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'itms-beta://x', 'not a url', '', '//example.com'])('refuses %j', (value) => {
    expect(httpsHref(value)).toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(httpsHref(null)).toBeNull();
    expect(httpsHref(undefined)).toBeNull();
  });
});
