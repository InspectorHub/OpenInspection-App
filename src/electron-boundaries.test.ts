import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanImports } from './offline/test-support/import-scan.ts';
import { importGraph } from './test-support/import-graph.ts';

// The desktop client has three zones: renderer code (`src/`), the privileged main process (`electron/`), and the
// bridge between them (`src/desktop/` on the renderer side, `electron/shared/` as the one module both may read).
const ROOT = join(import.meta.dirname, '..');

/** The only `src` modules the main process may import: pure code with no DOM, React or Capacitor behind it. */
const ALLOWED_SRC_MODULES = new Set([
  'src/platform/db',
  'src/platform/schema',
  'src/platform/files-path',
  'src/platform/https-href',
  'src/auth/callback-constants',
  'src/collab/timers',
  'src/media/upload-kinds',
  'src/media/media-types',
  'src/platform/uploader',
]);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const posix = (path: string): string => relative(ROOT, path).split(sep).join('/');

/** The repository-relative target of a relative specifier, without its extension; null for a package name. */
function localTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return posix(resolve(dirname(file), specifier)).replace(/\.(tsx?|[cm]?js)$/, '');
}

const isElectronPackage = (specifier: string): boolean => specifier === 'electron' || specifier.startsWith('electron/');

/** The main-process directory itself (a directory import such as `../../electron`) or anything inside it. */
const isElectronDir = (target: string): boolean => target === 'electron' || target.startsWith('electron/');
const isSharedDir = (target: string): boolean => target === 'electron/shared' || target.startsWith('electron/shared/');

/** What `scanImports` reports for a dynamic `import(x)` or `require(x)` whose argument it cannot read. */
const NON_LITERAL = '<non-literal>';

/** Rule 1, for every file outside `src/desktop/`: nothing may reach Electron or the main-process directory. */
function rendererViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      const target = localTarget(file, ref.specifier);
      return isElectronPackage(ref.specifier) || (target !== null && isElectronDir(target) && !isSharedDir(target));
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

/** Rule 2, for files in `src/desktop/`: the only way into the main-process directory is `electron/shared/`. */
function bridgeViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      const target = localTarget(file, ref.specifier);
      return isElectronPackage(ref.specifier) || (target !== null && isElectronDir(target) && !isSharedDir(target));
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

/**
 * Rule 3, for files in `electron/`: a local import must stay inside `electron/` or name an allowlisted `src` module, and a
 * dynamic `import(x)` or `require(x)` whose argument is not a plain string is refused, because it cannot be checked.
 */
function mainViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      if (ref.specifier === NON_LITERAL) return true;
      const target = localTarget(file, ref.specifier);
      return target !== null && !isElectronDir(target) && !ALLOWED_SRC_MODULES.has(target);
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

const readAll = (files: string[]): [string, string][] => files.map((file) => [file, readFileSync(file, 'utf8')]);
const runtimeFiles = (files: string[]): string[] => files.filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));

describe('desktop import boundaries', () => {
  const srcFiles = sourceFiles(join(ROOT, 'src'));
  const desktopDir = join(ROOT, 'src', 'desktop') + sep;
  const electronFiles = sourceFiles(join(ROOT, 'electron'));

  const rendererFile = join(ROOT, 'src', 'platform', 'fixture.ts');
  const bridgeFile = join(ROOT, 'src', 'desktop', 'fixture.ts');
  const mainFile = join(ROOT, 'electron', 'main', 'data', 'fixture.ts');

  it('scans a real set of files (the scan is not vacuously empty)', () => {
    expect(srcFiles.length).toBeGreaterThan(100);
    expect(electronFiles.length).toBeGreaterThan(0);
  });

  it('renderer code outside src/desktop never imports electron', () => {
    const outside = runtimeFiles(srcFiles).filter((file) => !file.startsWith(desktopDir));
    expect(readAll(outside).flatMap(([file, text]) => rendererViolations(file, text))).toEqual([]);
  });

  it('the renderer rule reports an electron import and a relative path into electron/', () => {
    expect(rendererViolations(rendererFile, "import { app } from 'electron';")).toHaveLength(1);
    expect(rendererViolations(rendererFile, "import { x } from '../../electron/main/index.ts';")).toHaveLength(1);
    expect(rendererViolations(rendererFile, "import { y } from './files-path.ts';\nimport z from 'react';")).toEqual([]);
  });

  it.each([
    ['export ... from', "export { app } from 'electron';"],
    ['export * from a relative path', "export * from '../../electron/main/index.ts';"],
    ['dynamic import', "const m = await import('electron');"],
    ['require', "const m = require('electron');"],
    ['a directory import that is electron itself', "import { x } from '../../electron';"],
  ])('the renderer rule reports %s', (_name, line) => {
    expect(rendererViolations(rendererFile, line)).toHaveLength(1);
  });

  it('the renderer rule lets the same syntax through when it does not name electron (control)', () => {
    expect(rendererViolations(rendererFile, "export { x } from './files-path.ts';\nconst m = await import('./https-href.ts');\nimport { y } from '../../src';")).toEqual([]);
  });

  it('src/desktop imports only electron/shared', () => {
    expect(readAll(runtimeFiles(srcFiles.filter((file) => file.startsWith(desktopDir)))).flatMap(([file, text]) => bridgeViolations(file, text))).toEqual([]);
  });

  it('the bridge rule rejects electron and electron/main, and accepts electron/shared', () => {
    expect(bridgeViolations(bridgeFile, "import { ipcRenderer } from 'electron';")).toHaveLength(1);
    expect(bridgeViolations(bridgeFile, "import { open } from '../../electron/main/data/db-open.ts';")).toHaveLength(1);
    expect(bridgeViolations(bridgeFile, "import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';")).toEqual([]);
  });

  it.each([
    ['export ... from', "export { ipcRenderer } from 'electron';"],
    ['export * from electron/main', "export * from '../../electron/main/index.ts';"],
    ['dynamic import', "const m = await import('../../electron/main/index.ts');"],
    ['require', "const m = require('electron');"],
    ['a directory import that is electron itself', "import { x } from '../../electron';"],
  ])('the bridge rule reports %s', (_name, line) => {
    expect(bridgeViolations(bridgeFile, line)).toHaveLength(1);
  });

  it('the bridge rule lets electron/shared through in every syntax, a directory import included (control)', () => {
    expect(
      bridgeViolations(
        bridgeFile,
        "export type { A } from '../../electron/shared/ipc-contract.ts';\nconst m = await import('../../electron/shared/ipc-contract.ts');\nimport type { B } from '../../electron/shared';",
      ),
    ).toEqual([]);
  });

  it('electron/ imports only the allowlisted src modules', () => {
    expect(readAll(runtimeFiles(electronFiles)).flatMap(([file, text]) => mainViolations(file, text))).toEqual([]);
  });

  it('the main-process rule rejects other src modules and accepts allowlisted ones, including import type', () => {
    expect(mainViolations(mainFile, "import { App } from '../../../src/App.tsx';")).toHaveLength(1);
    expect(mainViolations(mainFile, "import { x } from '../../../src/platform/files.ts';")).toHaveLength(1);
    expect(mainViolations(mainFile, "import type { Db } from '../../../src/platform/db.ts';")).toEqual([]);
    expect(mainViolations(mainFile, "import { MIGRATIONS } from '../../../src/platform/schema.ts';\nimport { c } from '../../shared/ipc-contract.ts';\nimport { app } from 'electron';")).toEqual([]);
  });

  it.each([
    ['export ... from', "export { x } from '../../../src/platform/files.ts';"],
    ['dynamic import', "const m = await import('../../../src/App.tsx');"],
    ['require', "const m = require('../../../src/App.tsx');"],
    ['a directory import of src', "import { x } from '../../../src';"],
    ['a dynamic import with an argument it cannot read', 'const m = await import(name);'],
    ['a require with an argument it cannot read', 'const m = require(name);'],
  ])('the main-process rule reports %s', (_name, line) => {
    expect(mainViolations(mainFile, line)).toHaveLength(1);
  });

  it('the main-process rule lets allowlisted code and electron/ itself through in every syntax (control)', () => {
    expect(
      mainViolations(
        mainFile,
        "export { MIGRATIONS } from '../../../src/platform/schema.ts';\nconst m = await import('../../../src/platform/db.ts');\nconst c = require('../../shared/ipc-contract.ts');\nimport { d } from '../..';\nconst n = require('node:fs');",
      ),
    ).toEqual([]);
  });

  describe('the allowlist is closed', () => {
    const allowedFiles = [...ALLOWED_SRC_MODULES].map((module) => `${module}.ts`);

    it.each(allowedFiles)('everything %s imports, recursively, is allowlisted too and no package is among it', (file) => {
      const graph = importGraph(file, { followDynamic: true });
      const outside = [...graph.files].filter((reached) => !ALLOWED_SRC_MODULES.has(reached.replace(/\.tsx?$/, '')));
      expect({ outside, packages: graph.packages }).toEqual({ outside: [], packages: [] });
    });

    it('the walk follows edges and would report a leak (control: a Capacitor adapter reaches a package and a file outside the set)', () => {
      expect([...importGraph('src/platform/schema.ts').files]).toContain('src/platform/db.ts');
      const leaky = importGraph('src/platform/db-capacitor.ts');
      expect(leaky.packages.some((ref) => ref.specifier.startsWith('@capacitor'))).toBe(true);
      expect([...leaky.files].some((reached) => !ALLOWED_SRC_MODULES.has(reached.replace(/\.tsx?$/, '')))).toBe(true);
    });
  });
});
