import { describe, expect, it } from 'vitest';
import { httpsHref } from './https-href';

describe('httpsHref', () => {
  it('returns the normalised address of an https url', () => {
    expect(httpsHref('https://Example.com/app.apk?x=1')).toBe('https://example.com/app.apk?x=1');
  });

  it.each(['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'itms-beta://x', 'not a url', '', '//example.com'])('refuses %j', (value) => {
    expect(httpsHref(value)).toBeNull();
  });

  it('refuses an address that carries a user name or password (control: the same address without one passes)', () => {
    expect(httpsHref('https://user:pw@example.com/app.apk')).toBeNull();
    expect(httpsHref('https://user@example.com/app.apk')).toBeNull();
    expect(httpsHref('https://example.com/app.apk')).not.toBeNull();
  });

  it('refuses an address longer than 2048 characters (control: exactly 2048 passes)', () => {
    const base = 'https://example.com/';
    expect(httpsHref(base + 'a'.repeat(2048 - base.length))).not.toBeNull();
    expect(httpsHref(base + 'a'.repeat(2049 - base.length))).toBeNull();
  });

  it('caps the input and the normalised address separately', () => {
    // Dot segments collapse, so this normalises to a short address; the long input is still refused.
    expect(httpsHref(`https://example.com/${'./'.repeat(1100)}ok`)).toBeNull();
    expect(httpsHref('https://example.com/./ok')).toBe('https://example.com/ok');
    // Spaces are written as %20: a short input that normalises to a long address is refused too.
    expect(httpsHref(`https://example.com/${'a b'.repeat(500)}`)).toBeNull();
    expect(httpsHref(`https://example.com/${'a b'.repeat(10)}`)).not.toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(httpsHref(null)).toBeNull();
    expect(httpsHref(undefined)).toBeNull();
  });
});
