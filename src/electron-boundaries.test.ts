import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanImports } from './offline/test-support/import-scan.ts';

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
  'src/media/upload-kinds',
  'src/media/media-types',
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

/** Rule 1, for every file outside `src/desktop/`: nothing may reach Electron or the main-process directory. */
function rendererViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      const target = localTarget(file, ref.specifier);
      return isElectronPackage(ref.specifier) || (target !== null && target.startsWith('electron/'));
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

/** Rule 2, for files in `src/desktop/`: the only way into the main-process directory is `electron/shared/`. */
function bridgeViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      const target = localTarget(file, ref.specifier);
      return isElectronPackage(ref.specifier) || (target !== null && target.startsWith('electron/') && !target.startsWith('electron/shared/'));
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

/** Rule 3, for files in `electron/`: a local import must stay inside `electron/` or name an allowlisted `src` module. */
function mainViolations(file: string, text: string): string[] {
  return scanImports(file, text)
    .filter((ref) => {
      const target = localTarget(file, ref.specifier);
      return target !== null && !target.startsWith('electron/') && !ALLOWED_SRC_MODULES.has(target);
    })
    .map((ref) => `${posix(file)} imports ${ref.specifier}`);
}

const readAll = (files: string[]): [string, string][] => files.map((file) => [file, readFileSync(file, 'utf8')]);

describe('desktop import boundaries', () => {
  const srcFiles = sourceFiles(join(ROOT, 'src'));
  const desktopDir = join(ROOT, 'src', 'desktop') + sep;
  const electronFiles = sourceFiles(join(ROOT, 'electron'));

  it('scans a real set of files (the scan is not vacuously empty)', () => {
    expect(srcFiles.length).toBeGreaterThan(100);
    expect(electronFiles.length).toBeGreaterThan(0);
  });

  it('renderer code outside src/desktop never imports electron', () => {
    const outside = srcFiles.filter((file) => !file.startsWith(desktopDir));
    expect(readAll(outside).flatMap(([file, text]) => rendererViolations(file, text))).toEqual([]);
  });

  it('the renderer rule reports an electron import and a relative path into electron/', () => {
    const file = join(ROOT, 'src', 'platform', 'fixture.ts');
    expect(rendererViolations(file, "import { app } from 'electron';")).toHaveLength(1);
    expect(rendererViolations(file, "import { x } from '../../electron/main/index.ts';")).toHaveLength(1);
    expect(rendererViolations(file, "import { y } from './files-path.ts';\nimport z from 'react';")).toEqual([]);
  });

  it('src/desktop imports only electron/shared', () => {
    expect(readAll(srcFiles.filter((file) => file.startsWith(desktopDir))).flatMap(([file, text]) => bridgeViolations(file, text))).toEqual([]);
  });

  it('the bridge rule rejects electron and electron/main, and accepts electron/shared', () => {
    const file = join(ROOT, 'src', 'desktop', 'fixture.ts');
    expect(bridgeViolations(file, "import { ipcRenderer } from 'electron';")).toHaveLength(1);
    expect(bridgeViolations(file, "import { open } from '../../electron/main/data/db-open.ts';")).toHaveLength(1);
    expect(bridgeViolations(file, "import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';")).toEqual([]);
  });

  it('electron/ imports only the allowlisted src modules', () => {
    expect(readAll(electronFiles).flatMap(([file, text]) => mainViolations(file, text))).toEqual([]);
  });

  it('the main-process rule rejects other src modules and accepts allowlisted ones, including import type', () => {
    const file = join(ROOT, 'electron', 'main', 'data', 'fixture.ts');
    expect(mainViolations(file, "import { App } from '../../../src/App.tsx';")).toHaveLength(1);
    expect(mainViolations(file, "import { x } from '../../../src/platform/files.ts';")).toHaveLength(1);
    expect(mainViolations(file, "import type { Db } from '../../../src/platform/db.ts';")).toEqual([]);
    expect(mainViolations(file, "import { MIGRATIONS } from '../../../src/platform/schema.ts';\nimport { c } from '../../shared/ipc-contract.ts';\nimport { app } from 'electron';")).toEqual([]);
  });
});
