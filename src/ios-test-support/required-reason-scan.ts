import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Required-reason API categories, as published by Apple (fetched 2026-10-31 from the documentation
 * data behind these pages):
 *   https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
 *   https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype
 *   https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons
 *
 * REASONS lists every approved code per category. SDK_ONLY_REASONS are the codes Apple says "may only
 * be declared by third-party SDKs", so an app manifest must not carry them.
 */
export const REASONS: Record<string, readonly string[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1'],
};

export const SDK_ONLY_REASONS: readonly string[] = ['0A2A.1', 'C56D.1'];

/*
 * Symbols Apple lists per category. The lookbehind on stat keeps a Swift method that merely happens to
 * be called "stat" (func stat(, .stat(url:)) from counting as a call to the C function.
 * creationDateTimestamp / modificationDateTimestamp are not on Apple's list; they are the accessors
 * through which the Filesystem plugin reads the timestamps that its ion-ios-filesystem dependency (a
 * remote Swift package, not on disk) obtains from the system, so they stand in for that call.
 */
const STAT = String.raw`(?<!func )(?:(?<![\w.])|(?<=\b(?:Darwin|Glibc)\.))(?:stat|fstat|lstat|fstatat)\s*\(`;
const ATTRLIST = String.raw`\b(?:getattrlist|getattrlistat|getattrlistbulk|fgetattrlist)\s*\(`;
export const SYMBOLS: Record<string, RegExp[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    /\b(?:creationDate|modificationDate|fileModificationDate|fileCreationDate|contentModificationDateKey|creationDateKey)\b/,
    /\b(?:NSFileCreationDate|NSFileModificationDate|NSURLContentModificationDateKey|NSURLCreationDateKey)\b/,
    /\b(?:creationDateTimestamp|modificationDateTimestamp)\b/,
    new RegExp(STAT),
    new RegExp(ATTRLIST),
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: [/\b(?:systemUptime|mach_absolute_time)\b/],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    /\b(?:volumeAvailableCapacityKey|volumeAvailableCapacityForImportantUsageKey|volumeAvailableCapacityForOpportunisticUsageKey|volumeTotalCapacityKey|NSURLVolumeAvailableCapacityKey|NSURLVolumeAvailableCapacityForImportantUsageKey|NSURLVolumeAvailableCapacityForOpportunisticUsageKey|NSURLVolumeTotalCapacityKey|systemFreeSize|systemSize|NSFileSystemFreeSize|NSFileSystemSize)\b/,
    /\b(?:statfs|statvfs|fstatfs|fstatvfs)\s*\(/,
    new RegExp(ATTRLIST),
  ],
  NSPrivacyAccessedAPICategoryActiveKeyboards: [/\bactiveInputModes\b/],
  NSPrivacyAccessedAPICategoryUserDefaults: [/\b(?:UserDefaults|NSUserDefaults)\b|@(?:AppStorage|SceneStorage)\b/],
};

const SOURCE_EXT = /\.(?:swift|m|mm|h|c|cc|cpp)$/;
const SKIP_DIR = /^(?:node_modules|\.build|Pods|.*Tests?)$/;

/**
 * Remove comments but keep string literals intact. Handles line comments, block comments (nested, as in
 * Swift), "..." and """...""" strings with backslash escapes, and C character literals such as '"'.
 * Known limit: Swift raw strings (#"..."#) are read as ordinary strings, so a raw string holding an
 * unescaped quote can desynchronise the reader for the rest of that file; no source we scan uses one.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const pair = text.slice(i, i + 2);
        if (pair === '/*') {
          depth++;
          i += 2;
        } else if (pair === '*/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      const ch = /^'(?:\\.|[^'\\\n])'/.exec(text.slice(i, i + 6));
      out += ch ? ch[0] : (text[i] ?? '');
      i += ch ? ch[0].length : 1;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) out.push(...sourceFiles(full));
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export interface ScanResult {
  /** Category -> files that use one of its symbols. Only categories with at least one hit appear. */
  used: Map<string, string[]>;
  filesScanned: number;
}

/** Scan every native source under the roots (comments stripped, test directories skipped). */
export function scanRequiredReasonApis(roots: string[]): ScanResult {
  const used = new Map<string, string[]>();
  let filesScanned = 0;
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      filesScanned++;
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const [category, patterns] of Object.entries(SYMBOLS)) {
        if (patterns.some((p) => p.test(text))) used.set(category, [...(used.get(category) ?? []), file]);
      }
    }
  }
  return { used, filesScanned };
}
