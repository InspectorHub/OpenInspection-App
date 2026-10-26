import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Ways code can put a URL into a WebView, an iframe or the current document. */
const NAVIGATION_SINKS = [
  /window\.location/,
  /\blocation\.(href|assign|replace)\b/,
  /\bwindow\.open\s*\(/,
  /<iframe/i,
  /\.src\s*=/,
  /setAttribute\(\s*['"]src['"]/,
  /\bloadUrl\s*\(/,
  /\bInAppBrowser\b/,
];

/** Things that must only ever go to the system browser tab. */
const SIGN_IN_PAGES = [/\/oauth\/authorize/, /\/login\b/, /buildAuthorizeUrl/, /serverEndpoints\([^)]*\)\.authorize/];

/** Returns why `source` navigates a WebView to a sign-in page, or null when it does not. */
function webviewSignInViolation(source: string): string | null {
  const sink = NAVIGATION_SINKS.find((re) => re.test(source));
  const page = SIGN_IN_PAGES.find((re) => re.test(source));
  if (sink && page) return `navigation sink ${String(sink)} in a file that names a sign-in page ${String(page)}`;
  if (/['"`]\/login\b/.test(source)) return 'a /login path literal';
  return null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}${name}`;
    if (statSync(full).isDirectory()) return name === 'api' ? [] : sourceFiles(`${full}/`);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes('/test-support/') ? [full] : [];
  });
}

describe('no WebView sign-in (P0-12)', () => {
  it('flags a WebView navigation to the authorize page (positive controls)', () => {
    expect(webviewSignInViolation("window.location.href = origin + '/oauth/authorize?x=1';")).not.toBeNull();
    expect(webviewSignInViolation('iframe.src = buildAuthorizeUrl(args);')).not.toBeNull();
    expect(webviewSignInViolation("window.open(`${origin}/oauth/authorize`)")).not.toBeNull();
    expect(webviewSignInViolation("const html = '<iframe src=\"' + serverEndpoints(o).authorize + '\">';")).not.toBeNull();
    expect(webviewSignInViolation("navigate('/login')")).not.toBeNull();
  });

  it('does not flag harmless code', () => {
    expect(webviewSignInViolation("await browser.open({ url: buildAuthorizeUrl(args) });")).toBeNull();
    expect(webviewSignInViolation("window.location.reload();")).toBeNull();
  });

  it('finds no violation in any source file', () => {
    const dir = fileURLToPath(new URL('../', import.meta.url));
    const files = sourceFiles(dir);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.map((f) => [f, webviewSignInViolation(readFileSync(f, 'utf8'))] as const).filter(([, why]) => why !== null);
    expect(offenders).toEqual([]);
  });
});
