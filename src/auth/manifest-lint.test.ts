import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** A small XML reader: enough for an Android manifest (no CDATA, no entities that matter here). */
function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const cleaned = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of cleaned.matchAll(/<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1] ?? ''] = a[2] ?? '';
    const node: XmlNode = { tag: tag ?? '', attrs, children: [] };
    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function find(node: XmlNode, tag: string): XmlNode[] {
  return [...(node.tag === tag ? [node] : []), ...node.children.flatMap((c) => find(c, tag))];
}

function resolveString(value: string | undefined, strings: Record<string, string>): string | undefined {
  const ref = /^@string\/(.+)$/.exec(value ?? '');
  return ref ? strings[ref[1] ?? ''] : value;
}

const SCHEME = 'io.inspectorhub.app';
const PATH_PREFIX = '/oauth/callback';

/** Returns every rule the manifests break; an empty array means they pass. */
function lintManifests(mainXml: string, debugXml: string, stringsXml: string): string[] {
  const problems: string[] = [];
  const strings: Record<string, string> = {};
  for (const s of find(parseXml(stringsXml), 'string')) {
    // string values are text nodes, which the tiny parser does not keep: read them directly
    const m = new RegExp(`<string name="${s.attrs.name ?? ''}">([^<]*)</string>`).exec(stringsXml);
    strings[s.attrs.name ?? ''] = m?.[1] ?? '';
  }
  const main = parseXml(mainXml);
  const debug = parseXml(debugXml);
  const app = find(main, 'application')[0];
  if (app?.attrs['android:allowBackup'] !== 'false') problems.push('allowBackup must be false');
  if (app?.attrs['android:usesCleartextTraffic'] === 'true') problems.push('cleartext must not be enabled in the main manifest');
  if (app?.attrs['android:networkSecurityConfig'] !== undefined) problems.push('main manifest must not widen the network security config');
  if (find(debug, 'application')[0]?.attrs['android:usesCleartextTraffic'] !== 'true') problems.push('debug overlay must enable cleartext');

  const activities = find(main, 'activity');
  const exported = activities.filter((a) => a.attrs['android:exported'] === 'true');
  if (activities.length !== 1 || exported.length !== 1) problems.push('exactly one activity, and it must be the only exported one');
  const activity = exported[0];
  if (activity?.attrs['android:launchMode'] !== 'singleTask') problems.push('launchMode must be singleTask');
  for (const other of [...find(main, 'service'), ...find(main, 'receiver'), ...find(main, 'provider')]) {
    if (other.attrs['android:exported'] === 'true') problems.push(`${other.tag} must not be exported`);
  }

  // Every VIEW filter of every activity and alias is checked, not just the first. The path attribute is
  // not a filter: Android ignores `pathPrefix` on a `<data>` that has no host, so the exact callback
  // match is made in code by `parseCallbackUrl`. It is allowed only in its one harmless form.
  const viewFilters = [...find(main, 'activity'), ...find(main, 'activity-alias')]
    .flatMap((a) => find(a, 'intent-filter'))
    .filter((f) => find(f, 'action').some((a) => a.attrs['android:name'] === 'android.intent.action.VIEW'));
  if (viewFilters.length === 0) problems.push('missing VIEW intent filter');
  for (const viewFilter of viewFilters) {
    const cats = find(viewFilter, 'category').map((c) => c.attrs['android:name']);
    if (!cats.includes('android.intent.category.DEFAULT')) problems.push('VIEW filter needs DEFAULT');
    if (!cats.includes('android.intent.category.BROWSABLE')) problems.push('VIEW filter needs BROWSABLE');
    const data = find(viewFilter, 'data');
    const schemes = data.map((d) => resolveString(d.attrs['android:scheme'], strings)).filter(Boolean);
    if (schemes.length !== 1 || schemes[0] !== SCHEME) problems.push(`VIEW filter scheme must be exactly ${SCHEME}`);
    const prefixes = data.map((d) => d.attrs['android:pathPrefix']).filter(Boolean);
    if (prefixes.some((prefix) => prefix !== PATH_PREFIX)) problems.push(`VIEW filter pathPrefix, when present, must be exactly ${PATH_PREFIX}`);
    if (data.some((d) => d.attrs['android:host'] !== undefined || d.attrs['android:path'] !== undefined)) {
      problems.push('VIEW filter must not add other hosts or paths');
    }
  }
  return problems;
}

const root = fileURLToPath(new URL('../../android/app/src/', import.meta.url));
const read = (p: string): string => readFileSync(`${root}${p}`, 'utf8');

const GOOD_MAIN = `<manifest xmlns:android="x"><application android:allowBackup="false">
  <activity android:name=".MainActivity" android:launchMode="singleTask" android:exported="true">
    <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    <intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="io.inspectorhub.app" android:pathPrefix="/oauth/callback" />
    </intent-filter>
  </activity>
  <provider android:name="p" android:exported="false" />
</application></manifest>`;
const GOOD_DEBUG = '<manifest xmlns:android="x"><application android:usesCleartextTraffic="true" /></manifest>';
const STRINGS = '<resources><string name="custom_url_scheme">io.inspectorhub.app</string></resources>';

describe('Android manifest lint (P0-13)', () => {
  it('passes the real manifests', () => {
    expect(lintManifests(read('main/AndroidManifest.xml'), read('debug/AndroidManifest.xml'), read('main/res/values/strings.xml'))).toEqual([]);
  });

  it('passes the synthetic good manifests (the controls below start from these)', () => {
    expect(lintManifests(GOOD_MAIN, GOOD_DEBUG, STRINGS)).toEqual([]);
  });

  it('catches a wrong scheme', () => {
    const bad = GOOD_MAIN.replace('android:scheme="io.inspectorhub.app"', 'android:scheme="evil.app"');
    expect(lintManifests(bad, GOOD_DEBUG, STRINGS)).toContain('VIEW filter scheme must be exactly io.inspectorhub.app');
  });

  it('allows pathPrefix to be absent (it is not what filters) but refuses a different one', () => {
    expect(lintManifests(GOOD_MAIN.replace(' android:pathPrefix="/oauth/callback"', ''), GOOD_DEBUG, STRINGS)).toEqual([]);
    expect(lintManifests(GOOD_MAIN.replace('/oauth/callback', '/'), GOOD_DEBUG, STRINGS)).toContain('VIEW filter pathPrefix, when present, must be exactly /oauth/callback');
  });

  const SECOND_FILTER = (scheme: string): string => `<intent-filter>
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="${scheme}" />
    </intent-filter>`;

  it('checks every VIEW filter, not only the first (positive control: a second correct filter passes)', () => {
    const withSecond = (scheme: string): string => GOOD_MAIN.replace('</activity>', `${SECOND_FILTER(scheme)}</activity>`);
    expect(lintManifests(withSecond('io.inspectorhub.app'), GOOD_DEBUG, STRINGS)).toEqual([]);
    expect(lintManifests(withSecond('evil.app'), GOOD_DEBUG, STRINGS)).toContain('VIEW filter scheme must be exactly io.inspectorhub.app');
  });

  it('checks the VIEW filters of an activity-alias too (positive control: a correct alias passes)', () => {
    const withAlias = (scheme: string): string =>
      GOOD_MAIN.replace('</application>', `<activity-alias android:name=".Alias" android:targetActivity=".MainActivity" android:exported="true">${SECOND_FILTER(scheme)}</activity-alias></application>`);
    expect(lintManifests(withAlias('io.inspectorhub.app'), GOOD_DEBUG, STRINGS)).toEqual([]);
    expect(lintManifests(withAlias('evil.app'), GOOD_DEBUG, STRINGS)).toContain('VIEW filter scheme must be exactly io.inspectorhub.app');
  });

  it('catches a second exported activity', () => {
    const bad = GOOD_MAIN.replace('</application>', '<activity android:name=".Other" android:exported="true" /></application>');
    expect(lintManifests(bad, GOOD_DEBUG, STRINGS)).toContain('exactly one activity, and it must be the only exported one');
  });

  it('catches a missing singleTask', () => {
    expect(lintManifests(GOOD_MAIN.replace('singleTask', 'standard'), GOOD_DEBUG, STRINGS)).toContain('launchMode must be singleTask');
  });

  it('catches allowBackup left on', () => {
    expect(lintManifests(GOOD_MAIN.replace('allowBackup="false"', 'allowBackup="true"'), GOOD_DEBUG, STRINGS)).toContain('allowBackup must be false');
  });

  it('catches cleartext in the main manifest, and a debug overlay without it', () => {
    const bad = GOOD_MAIN.replace('android:allowBackup="false"', 'android:allowBackup="false" android:usesCleartextTraffic="true"');
    expect(lintManifests(bad, GOOD_DEBUG, STRINGS)).toContain('cleartext must not be enabled in the main manifest');
    expect(lintManifests(GOOD_MAIN, '<manifest><application /></manifest>', STRINGS)).toContain('debug overlay must enable cleartext');
  });

  it('catches an exported provider and a missing BROWSABLE category', () => {
    expect(lintManifests(GOOD_MAIN.replace('android:exported="false"', 'android:exported="true"'), GOOD_DEBUG, STRINGS)).toContain('provider must not be exported');
    expect(lintManifests(GOOD_MAIN.replace('<category android:name="android.intent.category.BROWSABLE" />', ''), GOOD_DEBUG, STRINGS)).toContain('VIEW filter needs BROWSABLE');
  });
});
