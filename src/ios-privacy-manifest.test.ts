import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPlist, type PlistValue } from './ios-test-support/plist';
import { REASONS, SDK_ONLY_REASONS, scanRequiredReasonApis } from './ios-test-support/required-reason-scan';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const manifestText = read('ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
const manifest = readPlist(manifestText);
const project = read('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const spmPackage = read('ios', 'App', 'CapApp-SPM', 'Package.swift');

/** Category -> declared reasons. */
function declared(plist: Map<string, PlistValue>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const types = plist.get('NSPrivacyAccessedAPITypes');
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    if (!(entry instanceof Map)) continue;
    const category = entry.get('NSPrivacyAccessedAPIType');
    const reasons = entry.get('NSPrivacyAccessedAPITypeReasons');
    if (typeof category === 'string') {
      out.set(category, Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : []);
    }
  }
  return out;
}

/** Categories that are used but have no declared reason, plus declared reasons Apple does not define. */
function manifestProblems(plist: Map<string, PlistValue>, used: Map<string, string[]>): string[] {
  const decl = declared(plist);
  const problems: string[] = [];
  for (const category of used.keys()) {
    if ((decl.get(category) ?? []).length === 0) problems.push(`${category} is used but has no declared reason`);
  }
  for (const [category, reasons] of decl) {
    const allowed = REASONS[category];
    if (!allowed) problems.push(`${category} is not an Apple category`);
    for (const r of reasons) {
      if (!allowed?.includes(r)) problems.push(`${category}: ${r} is not an approved reason`);
      if (SDK_ONLY_REASONS.includes(r)) problems.push(`${category}: ${r} may only be declared by a third-party SDK`);
    }
  }
  return problems.sort();
}

/** The native source roots: the app's own Swift plus the iOS sources of every plugin the SPM package links. */
function nativeRoots(): string[] {
  const plugins = [...spmPackage.matchAll(/path:\s*"\.\.\/\.\.\/\.\.\/(node_modules\/[^"]+)"/g)].map((m) => m[1] ?? '');
  return [join(ROOT, 'ios', 'App', 'App'), ...plugins.map((p) => join(ROOT, p, 'ios'))];
}

/** Files in the Resources build phase that belongs to the target named App (not just the first such phase in the file). */
function appResourcesFiles(text: string): string {
  const target = /isa = PBXNativeTarget;[\s\S]*?buildPhases = \(([\s\S]*?)\);[\s\S]*?name = App;/.exec(text)?.[1] ?? '';
  const phaseId = /([0-9A-F]{24}) \/\* Resources \*\//.exec(target)?.[1];
  if (!phaseId) return '';
  const start = text.indexOf(`${phaseId} /* Resources */ = {`);
  if (start < 0) return '';
  return /isa = PBXResourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/.exec(text.slice(start))?.[1] ?? '';
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rr-scan-'));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const MANIFEST_WITH_USERDEFAULTS = `<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><array><dict>
<key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryUserDefaults</string>
<key>NSPrivacyAccessedAPITypeReasons</key><array><string>CA92.1</string></array></dict></array></dict></plist>`;

describe('the scanner', () => {
  it('finds a required-reason symbol, ignores comments and a method that is merely called stat', () => {
    const dir = fixture({
      'A.swift': 'let d = UserDefaults.standard\nlet t = try fm.attributesOfItem(atPath: p)[.modificationDate]',
      'B.swift': '// UserDefaults is only mentioned here\n/* systemUptime */\n@objc func stat(_ call: X) {}\nlet op = FilesystemOperation.stat(url: u)',
      'Tests/C.swift': 'UserDefaults.standard',
    });
    const { used, filesScanned } = scanRequiredReasonApis([dir]);
    expect(filesScanned).toBe(2);
    expect([...used.keys()].sort()).toEqual(['NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategoryUserDefaults']);
    expect(used.get('NSPrivacyAccessedAPICategoryUserDefaults')).toEqual([join(dir, 'A.swift')]);
  });

  it('counts the C functions Apple lists', () => {
    const dir = fixture({ 'a.c': 'int r = stat(path, &sb); mach_absolute_time(); statvfs(p, &v);' });
    expect([...scanRequiredReasonApis([dir]).used.keys()].sort()).toEqual([
      'NSPrivacyAccessedAPICategoryDiskSpace',
      'NSPrivacyAccessedAPICategoryFileTimestamp',
      'NSPrivacyAccessedAPICategorySystemBootTime',
    ]);
  });
});

describe('the scanner, hardened', () => {
  const cats = (files: Record<string, string>): string[] => [...scanRequiredReasonApis([fixture(files)]).used.keys()].sort();
  const DISK = 'NSPrivacyAccessedAPICategoryDiskSpace';
  const STAMP = 'NSPrivacyAccessedAPICategoryFileTimestamp';
  const BOOT = 'NSPrivacyAccessedAPICategorySystemBootTime';
  const DEFAULTS = 'NSPrivacyAccessedAPICategoryUserDefaults';

  it('sees the Objective-C volume capacity names', () => {
    for (const key of ['NSURLVolumeAvailableCapacityKey', 'NSURLVolumeAvailableCapacityForImportantUsageKey', 'NSURLVolumeAvailableCapacityForOpportunisticUsageKey', 'NSURLVolumeTotalCapacityKey']) {
      expect(cats({ 'a.m': `[u getResourceValue:&v forKey:${key} error:nil];` })).toEqual([DISK]);
    }
    expect(cats({ 'a.m': 'NSLog(@"volume");' })).toEqual([]);
  });

  it('sees stat called through Darwin or Glibc, but not a method named stat', () => {
    expect(cats({ 'a.swift': 'Darwin.stat(path, &sb)' })).toEqual([STAMP]);
    expect(cats({ 'a.swift': 'Glibc.lstat(path, &sb)' })).toEqual([STAMP]);
    expect(cats({ 'a.swift': 'Darwin.fstat(fd, &sb)' })).toEqual([STAMP]);
    expect(cats({ 'a.swift': 'foo.stat(path)' })).toEqual([]);
  });

  it('treats @AppStorage and @SceneStorage as user defaults', () => {
    expect(cats({ 'a.swift': '@AppStorage("k") var k = 1' })).toEqual([DEFAULTS]);
    expect(cats({ 'a.swift': '@SceneStorage("k") var k = 1' })).toEqual([DEFAULTS]);
    expect(cats({ 'a.swift': 'let AppStorage = 1' })).toEqual([]);
  });

  it('reads .cpp and .cc files', () => {
    expect(cats({ 'a.cpp': 'auto t = mach_absolute_time();' })).toEqual([BOOT]);
    expect(cats({ 'a.cc': 'auto t = mach_absolute_time();' })).toEqual([BOOT]);
  });

  it('does not let a block-comment opener inside a string hide the code after it', () => {
    expect(cats({ 'a.swift': 'let a = "/*"\nlet d = UserDefaults.standard\n// */' })).toEqual([DEFAULTS]);
    expect(cats({ 'a.swift': 'let u = "http://x"; let d = UserDefaults.standard' })).toEqual([DEFAULTS]);
  });

  it('handles nested Swift block comments', () => {
    expect(cats({ 'a.swift': '/* outer /* inner */ UserDefaults.standard */\nlet x = 1' })).toEqual([]);
    expect(cats({ 'a.swift': '/* outer /* inner */ still comment */\nlet t = mach_absolute_time()' })).toEqual([BOOT]);
  });
});

describe('manifestProblems', () => {
  const used = new Map([['NSPrivacyAccessedAPICategoryUserDefaults', ['x']]]);

  it('is clean when every used category has an approved reason', () => {
    expect(manifestProblems(readPlist(MANIFEST_WITH_USERDEFAULTS), used)).toEqual([]);
  });

  it('flags a used category with no declared reason', () => {
    const empty = readPlist('<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><array/></dict></plist>');
    expect(manifestProblems(empty, used)).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults is used but has no declared reason']);
  });

  it('flags an invented reason code and an SDK-only reason', () => {
    const bad = readPlist(MANIFEST_WITH_USERDEFAULTS.replace('CA92.1', 'ZZZZ.9'));
    expect(manifestProblems(bad, used)).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults: ZZZZ.9 is not an approved reason']);
    const sdk = readPlist(MANIFEST_WITH_USERDEFAULTS.replace('CA92.1', 'C56D.1'));
    expect(manifestProblems(sdk, used)).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults: C56D.1 may only be declared by a third-party SDK']);
  });
});

describe('PrivacyInfo.xcprivacy', () => {
  it('does not track and lists no tracking domains', () => {
    expect(manifest.get('NSPrivacyTracking')).toBe(false);
    expect(manifest.get('NSPrivacyTrackingDomains')).toEqual([]);
    expect(manifest.has('NSPrivacyCollectedDataTypes')).toBe(true);
  });

  it('is in the project as a file reference and in the App target Resources phase', () => {
    expect(project).toMatch(/isa = PBXFileReference;[^\n]*path = PrivacyInfo\.xcprivacy;/);
    const resources = appResourcesFiles(project);
    expect(resources).toContain('PrivacyInfo.xcprivacy in Resources');
    // Positive control: the same probe sees a file that is known to be bundled.
    expect(resources).toContain('Assets.xcassets in Resources');
  });

  it('is rejected by the probe when only the reference exists', () => {
    const referenceOnly = project.replace(/^[^\n]*PrivacyInfo\.xcprivacy in Resources[^\n]*\n/gm, '');
    const resources = appResourcesFiles(referenceOnly);
    expect(resources).not.toContain('PrivacyInfo.xcprivacy');
    expect(resources).toContain('Assets.xcassets in Resources');
  });

  it('looks at the App target, not at some other Resources phase in the file', () => {
    const decoyPhase = '\t\tDEC0DE000000000000000001 /* Resources */ = {\r\n\t\t\tisa = PBXResourcesBuildPhase;\r\n\t\t\tfiles = (\r\n\t\t\t\tAB /* PrivacyInfo.xcprivacy in Resources */,\r\n\t\t\t);\r\n\t\t};\r\n';
    const section = '/* Begin PBXResourcesBuildPhase section */\r\n';
    const withDecoy = project.replace(section, section + decoyPhase);
    expect(withDecoy).toContain('DEC0DE000000000000000001');
    expect(appResourcesFiles(withDecoy)).toBe(appResourcesFiles(project));
    // Without the App target's own entry, a decoy phase holding the file must not make the probe pass.
    const withoutAppEntry = withDecoy.replace(/^[^\n]*A1B2C3D42FEA00010072D4E8 \/\* PrivacyInfo\.xcprivacy in Resources \*\/,\r?\n/m, '');
    expect(appResourcesFiles(withoutAppEntry)).not.toContain('PrivacyInfo');
    expect(appResourcesFiles(withoutAppEntry)).not.toContain('PrivacyInfo');
  });

  it('declares a reason for every required-reason category the app and its plugins use, and nothing else', () => {
    const roots = nativeRoots();
    expect(roots.length).toBeGreaterThan(12);
    const { used, filesScanned } = scanRequiredReasonApis(roots);
    // An empty scan would pass vacuously, so the scanner has to prove it reads real files and sees the known users.
    expect(filesScanned).toBeGreaterThan(20);
    expect(used.get('NSPrivacyAccessedAPICategoryUserDefaults')?.some((f) => f.includes('PreferencesPlugin'))).toBe(true);
    expect(used.get('NSPrivacyAccessedAPICategoryFileTimestamp')?.some((f) => f.includes('FilesystemPlugin'))).toBe(true);
    expect(manifestProblems(manifest, used)).toEqual([]);
    expect([...declared(manifest).keys()].sort()).toEqual([...used.keys()].sort());
  });
});
