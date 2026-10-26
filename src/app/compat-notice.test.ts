import { describe, expect, it } from 'vitest';
import type { CompatInfo } from '../auth/server-config';
import { compareVersions, compatNotices } from './compat-notice';

function compat(over: Partial<CompatInfo> = {}): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 1, serverTooOld: false, nativeLoginVerified: false, ...over };
}

describe('compareVersions', () => {
  it('orders dotted numbers numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('is unknown for anything that is not dotted numbers', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeNull();
    expect(compareVersions('', '1.0.0')).toBeNull();
  });
});

describe('compatNotices', () => {
  it('says nothing when the server and the app are current', () => {
    expect(compatNotices(compat({ minSupported: '1.0.0', recommended: '1.0.0' }), '1.0.0')).toEqual([]);
  });

  it('flags a server on an older contract', () => {
    expect(compatNotices(compat({ serverTooOld: true, serverContractVersion: 0 }), '1.0.0')).toEqual(['server_too_old']);
  });

  it('flags a newer recommended version as an available update', () => {
    expect(compatNotices(compat({ recommended: '1.1.0' }), '1.0.0')).toEqual(['update_available']);
  });

  it('flags an app below the minimum as required, and not also as available', () => {
    expect(compatNotices(compat({ minSupported: '1.0.0', recommended: '1.1.0' }), '0.9.0')).toEqual(['update_required']);
  });

  it('an unparseable version raises no notice rather than a wrong one', () => {
    expect(compatNotices(compat({ minSupported: 'next', recommended: 'latest' }), '1.0.0')).toEqual([]);
  });
});
