import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { scanImports, type ImportRef } from '../offline/test-support/import-scan';

const ROOT = join(import.meta.dirname, '..', '..');

export interface ImportGraph {
  /** Repository-relative, forward-slash paths of every source file reached, the entry included. */
  files: Set<string>;
  /** Every reference found in those files whose specifier does not start with a dot (a package or a builtin), with the file it is in. */
  packages: { file: string; specifier: string; kind: ImportRef['kind'] }[];
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** The source file a relative specifier names, or null for a file that is not TypeScript (a stylesheet, an image). */
export function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.[cm]?js$/, ''));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export const repoPath = (file: string): string => relative(ROOT, file).split(sep).join('/');

/**
 * Every source file reachable from `entry` through relative imports, and every package specifier seen on the way. Type-only
 * references count: the point is what a program has to load or type-check, not only what it runs. Dynamic imports with a literal
 * specifier are followed only when `followDynamic` is set.
 */
export function importGraph(entry: string, options: { followDynamic?: boolean } = {}): ImportGraph {
  const files = new Set<string>();
  const packages: ImportGraph['packages'] = [];
  const queue = [resolve(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const ref of scanImports(file, readFileSync(file, 'utf8'))) {
      if (ref.kind === 'dynamic-import' && options.followDynamic !== true) continue;
      if (!ref.specifier.startsWith('.')) {
        packages.push({ file: repoPath(file), specifier: ref.specifier, kind: ref.kind });
        continue;
      }
      const next = resolveLocal(file, ref.specifier);
      if (next !== null) queue.push(next);
    }
  }
  return { files: new Set([...files].map(repoPath)), packages };
}
