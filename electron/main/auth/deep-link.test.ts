import { describe, expect, it, vi } from 'vitest';
import { createDeepLinkHub, extractCallbackUrl } from './deep-link.ts';

const callback = 'io.inspectorhub.app:/oauth/callback?code=SECRET&state=state';

describe('deep-link callbacks', () => {
  it('extracts the first valid callback from quoted Windows argv and ignores invalid candidates', () => {
    expect(extractCallbackUrl(['app.exe', '"io.inspectorhub.app:/oauth/other?code=no"', `"${callback}"`, 'io.inspectorhub.app:/oauth/callback?code=second'])).toBe(callback);
  });

  it('rejects callback arguments over 4096 characters', () => {
    expect(extractCallbackUrl([`${callback}&padding=${'x'.repeat(4100)}`])).toBeNull();
  });

  it('buffers only the latest callback until a subscriber arrives and never logs its secret', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = createDeepLinkHub();
    hub.push('io.inspectorhub.app:/oauth/callback?code=OLDER&state=s');
    hub.push(callback);
    const received: string[] = [];
    hub.subscribe((url) => received.push(url));
    expect(received).toEqual([callback]);
    expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET');
    log.mockRestore();
  });
});
