import type { CompatInfo } from '../auth/server-config';

export type CompatNotice = 'server_too_old' | 'update_required' | 'update_available';

/** Dotted numeric versions only; anything else compares as unknown. */
function parts(version: string): number[] | null {
  const numbers = version.split('.').map((p) => (/^\d{1,9}$/.test(p) ? Number(p) : Number.NaN));
  return numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

/** Negative when `a` is older than `b`; null when either is not a dotted number. */
export function compareVersions(a: string, b: string): number | null {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * States to show beside the sign-in button. None of them blocks sign-in: a server that is
 * too old, or an app that is behind, still lets the person in to their offline data.
 */
export function compatNotices(compat: CompatInfo, appVersion: string): CompatNotice[] {
  const notices: CompatNotice[] = [];
  if (compat.serverTooOld) notices.push('server_too_old');
  const belowMinimum = compat.minSupported !== null && (compareVersions(appVersion, compat.minSupported) ?? 0) < 0;
  const belowRecommended = compat.recommended !== null && (compareVersions(appVersion, compat.recommended) ?? 0) < 0;
  if (belowMinimum) notices.push('update_required');
  else if (belowRecommended) notices.push('update_available');
  return notices;
}
