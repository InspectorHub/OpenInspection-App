import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALLBACK_SCHEME } from './auth/callback-constants';
import { readPlist, type PlistValue } from './ios-test-support/plist';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const plistText = read('ios', 'App', 'App', 'Info.plist');
const info = readPlist(plistText);
const project = read('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const appId = /appId:\s*'([^']+)'/.exec(read('capacitor.config.ts'))?.[1];

const settings = (text: string, name: string): string[] =>
  [...text.matchAll(new RegExp(String.raw`^\s*${name} = ([^;]*);$`, 'gm'))].map((m) => (m[1] ?? '').replaceAll('"', ''));

function urlSchemes(plist: Map<string, PlistValue>): string[] {
  const types = plist.get('CFBundleURLTypes');
  if (!Array.isArray(types)) return [];
  return types.flatMap((t: unknown) => {
    const schemes = t instanceof Map ? (t.get('CFBundleURLSchemes') as PlistValue | undefined) : undefined;
    return Array.isArray(schemes) ? schemes.filter((x): x is string => typeof x === 'string') : [];
  });
}

/** Problems with the declared usage descriptions; empty means the plist passes. */
function usageProblems(plist: Map<string, PlistValue>): string[] {
  const problems: string[] = [];
  for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
    const v = plist.get(key);
    if (typeof v !== 'string' || v.trim() === '') problems.push(`missing or empty ${key}`);
  }
  for (const [key, v] of plist) {
    if (key.endsWith('UsageDescription') && (typeof v !== 'string' || v.trim() === '')) problems.push(`empty ${key}`);
  }
  return problems;
}

// Nothing in src/, ios/ or the plugins' iOS sources saves to the photo library, records audio or
// calls the background-fetch APIs (0 hits, recorded in the commit message). The uploader plugin does
// create a background URLSession (URLSessionConfiguration.background(withIdentifier:)), which needs
// no UIBackgroundModes entry; its README treats the "fetch" mode as optional, only for waking the
// app on completion, and no handleEventsForBackgroundURLSession handler exists anywhere. So none of
// these keys may exist; a mode is added only together with code that uses it.
const UNUSED_KEYS = ['NSPhotoLibraryAddUsageDescription', 'NSMicrophoneUsageDescription', 'UIBackgroundModes'];
const UNUSED_PREFIXES = ['NSLocation', 'NSContacts', 'NSBluetooth'];

function unusedCapabilityKeys(plist: Map<string, PlistValue>): string[] {
  return [...plist.keys()].filter((k) => UNUSED_KEYS.includes(k) || UNUSED_PREFIXES.some((p) => k.startsWith(p))).sort();
}

const injectBefore = (text: string, key: string, xml: string): string => text.replace(`<key>${key}</key>`, `${xml}<key>${key}</key>`);
const withOtherScheme = (text: string): string => text.replace(/(<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>)[^<]*/, '$1io.inspectorhub.other');

describe('readPlist', () => {
  it('reads strings, booleans, arrays and nested dicts', () => {
    const p = readPlist('<plist version="1.0"><dict><key>a</key><string>x &amp; y</string><key>b</key><true/><key>c</key><array><string>1</string></array><key>d</key><dict><key>e</key><false/></dict></dict></plist>');
    expect(p.get('a')).toBe('x & y');
    expect(p.get('b')).toBe(true);
    expect(p.get('c')).toEqual(['1']);
    expect((p.get('d') as Map<string, PlistValue>).get('e')).toBe(false);
  });

  it('throws on an element it does not support instead of ignoring it', () => {
    expect(() => readPlist('<plist><dict><key>n</key><integer>1</integer></dict></plist>')).toThrow(/unsupported/);
  });

  const wrap = (body: string): string => `<plist><dict>${body}</dict></plist>`;

  it('throws on a duplicate key', () => {
    expect(() => readPlist(wrap('<key>a</key><string>1</string><key>a</key><string>2</string>'))).toThrow(/duplicate/);
    expect(readPlist(wrap('<key>a</key><string>1</string><key>b</key><string>2</string>')).size).toBe(2); // control
  });

  it('throws on a CDATA section', () => {
    expect(() => readPlist(wrap('<key>a</key><string><![CDATA[x]]></string>'))).toThrow(/unsupported/);
  });

  it('throws on a stray less-than sign it cannot tokenise', () => {
    expect(() => readPlist(wrap('<key>a</key><string>1 < 2</string>'))).toThrow(/unsupported/);
  });

  it('throws on a numeric or unknown entity instead of leaving it undecoded', () => {
    expect(() => readPlist(wrap('<key>a</key><string>&#65;</string>'))).toThrow(/entity/);
    expect(() => readPlist(wrap('<key>a</key><string>&nbsp;</string>'))).toThrow(/entity/);
    expect(readPlist(wrap('<key>a</key><string>&amp;&lt;&gt;&quot;&apos;</string>')).get('a')).toBe(`&<>"'`); // control
  });
});

describe('iOS project configuration', () => {
  it('capacitor.config.ts has an appId (the comparison below is not against undefined)', () => {
    expect(appId).toBe('io.inspectorhub.app');
  });

  it('bundle id equals capacitor appId in every build configuration', () => {
    const ids = settings(project, 'PRODUCT_BUNDLE_IDENTIFIER');
    expect(ids).toHaveLength(2); // Debug and Release
    for (const id of ids) expect(id).toBe(appId);
  });

  it('url scheme equals CALLBACK_SCHEME', () => {
    expect(urlSchemes(info)).toEqual([CALLBACK_SCHEME]);
    expect(urlSchemes(readPlist(withOtherScheme(plistText)))).toEqual(['io.inspectorhub.other']); // control
  });

  it('the callback scheme is the same on every platform', () => {
    expect(urlSchemes(info)).toContain(CALLBACK_SCHEME);
    expect(read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml')).toContain(`<string name="custom_url_scheme">${CALLBACK_SCHEME}</string>`);
    expect(read('electron', 'main', 'auth', 'protocol-client.ts')).toContain(`options.scheme ?? '${CALLBACK_SCHEME}'`);
    // control: an iOS plist with another scheme must not satisfy the iOS half
    expect(urlSchemes(readPlist(withOtherScheme(plistText)))).not.toContain(CALLBACK_SCHEME);
  });

  it('every declared usage description is non-empty and every requested capability has one', () => {
    expect(usageProblems(info)).toEqual([]);
    const removed = plistText.replace(/<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*<\/string>/, '');
    expect(usageProblems(readPlist(removed))).toEqual(['missing or empty NSCameraUsageDescription']);
    const emptied = plistText.replace(/(<key>NSCameraUsageDescription<\/key>\s*<string>)[^<]*/, '$1');
    expect(usageProblems(readPlist(emptied)).length).toBeGreaterThan(0);
  });

  it('no usage description or background mode for a capability nothing uses', () => {
    expect(info.has('NSCameraUsageDescription')).toBe(true); // positive control
    expect(unusedCapabilityKeys(info)).toEqual([]);
    // control: the checker does flag them when present
    const extra = injectBefore(
      plistText,
      'LSRequiresIPhoneOS',
      '<key>UIBackgroundModes</key><array><string>fetch</string></array><key>NSMicrophoneUsageDescription</key><string>x</string>',
    );
    expect(unusedCapabilityKeys(readPlist(extra))).toEqual(['NSMicrophoneUsageDescription', 'UIBackgroundModes']);
  });

  it('no arbitrary ATS exception in the release plist', () => {
    const arbitrary = (plist: Map<string, PlistValue>): boolean => {
      const ats = plist.get('NSAppTransportSecurity');
      return ats instanceof Map && ats.get('NSAllowsArbitraryLoads') === true;
    };
    expect(arbitrary(info)).toBe(false);
    const bad = injectBefore(plistText, 'LSRequiresIPhoneOS', '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>');
    expect(arbitrary(readPlist(bad))).toBe(true); // control
  });

  it('export compliance: ITSAppUsesNonExemptEncryption is true and the compliance code, when present, is a non-empty string', () => {
    expect(info.get('ITSAppUsesNonExemptEncryption')).toBe(true);
    const code = info.get('ITSEncryptionExportComplianceCode');
    if (code !== undefined) expect(typeof code === 'string' && code.trim() !== '').toBe(true);
  });

  it('the app icon is a 1024x1024 PNG', () => {
    const png = readFileSync(join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
  });

  it('deployment target is at least 15.0 in every configuration', () => {
    const targets = settings(project, 'IPHONEOS_DEPLOYMENT_TARGET');
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const t of targets) expect(Number.parseFloat(t)).toBeGreaterThanOrEqual(15);
  });
});
