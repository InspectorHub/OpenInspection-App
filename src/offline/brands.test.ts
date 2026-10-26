import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanImports, type ImportRef } from './test-support/import-scan';

/**
 * The issuer brand of a plan and the purge authority are conventions the compiler cannot enforce on their own: any module
 * could import them. So the set of modules that may is pinned here, and a new importer fails this test until a person
 * decides it belongs on the list. The scan parses each file with the TypeScript compiler and sees every way of referring to
 * a module (see `test-support/import-scan.ts`); a plain-text search missed namespace imports, double quotes, dynamic
 * imports, re-exports and type imports.
 *
 * The same scan also pins that no production file reaches into test support: the helpers there (`issuePlanForTest`,
 * `purgeAuthorityForTest`, `neverBlocked`) bypass exactly the protections these conventions give.
 */
const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name)) out.push(relative(SRC, full).split(sep).join('/'));
  }
  return out.sort();
}

const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);
/** Test support: a `test-support` directory anywhere, or a module named `test-support`. Used only by tests. */
const isSupportFile = (file: string): boolean => file.split('/').includes('test-support') || /(^|\/)test-support\.tsx?$/.test(file);
const isProduction = (file: string): boolean => !isTestFile(file) && !isSupportFile(file);

type Refs = ReadonlyMap<string, ImportRef[]>;

const scanned = (files: string[]): Map<string, ImportRef[]> => new Map(files.map((file) => [file, scanImports(file, readFileSync(join(SRC, file), 'utf8'))]));
const all = sources(SRC);
const production = scanned(all.filter(isProduction));
/** The one support module that is allowed to hold the brands: it builds the fixtures the tests of the checks need. */
const withSupport = scanned([...production.keys(), 'offline/test-support/brands.ts']);

/** The src-relative path (no extension) a relative specifier from `from` names; null for a package. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return join(dirname(from), specifier).split(sep).join('/').replace(/\.(?:tsx?|mjs|js)$/, '');
}

/** Files that refer to `target` (a src-relative path without extension) taking one of `names` (any name when empty). */
function importers(refs: Refs, target: string, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const [file, list] of refs) {
    if (file.replace(/\.tsx?$/, '') === target) continue;
    if (list.some((ref) => resolveSpecifier(file, ref.specifier) === target && (names.length === 0 || ref.names === '*' || ref.names.some((name) => names.includes(name))))) out.push(file);
  }
  return out.sort();
}

/** Files that name test support or the never-blocked guard, by the specifier as written. */
function supportReaders(refs: Refs): string[] {
  const out: string[] = [];
  for (const [file, list] of refs) {
    if (list.some((ref) => ref.specifier.includes('test-support') || ref.specifier.includes('never-blocked'))) out.push(file);
  }
  return out.sort();
}

/** Files with a dynamic import or require whose argument cannot be read: the scan cannot vouch for them. */
function unreadable(refs: Refs): string[] {
  const out: string[] = [];
  for (const [file, list] of refs) if (list.some((ref) => ref.specifier === '<non-literal>')) out.push(file);
  return out.sort();
}

const ISSUING = ['issuePlan', 'markIssued'];
const AUTHORITY = ['purgeAuthority'];

describe('who may use the brands', () => {
  it('only the decision and the test support may issue a plan', () => {
    expect(importers(withSupport, 'offline/plan-brand', ISSUING)).toEqual(['offline/reconcile-decision.ts', 'offline/test-support/brands.ts']);
  });

  it('only the person-confirmed actions, the purge itself and the test support may take the purge authority', () => {
    expect(importers(withSupport, 'offline/purge-authority', AUTHORITY)).toEqual(['offline/purge.ts', 'offline/test-support/brands.ts', 'offline/user-actions.ts']);
  });

  it('whatever the syntax or the names taken, only these production files refer to the brand modules at all', () => {
    expect(importers(production, 'offline/plan-brand', [])).toEqual(['offline/purge.ts', 'offline/reconcile-decision.ts', 'offline/reconcile-execute.ts', 'offline/user-actions.ts']);
    expect(importers(production, 'offline/purge-authority', [])).toEqual(['offline/purge.ts', 'offline/user-actions.ts']);
  });

  it('the scan sees what it is looking for: the files that are allowed are found by the same scan', () => {
    expect(importers(production, 'offline/plan-brand', ['isIssuedPlan']).length).toBeGreaterThan(0);
    expect(production.size).toBeGreaterThan(50);
  });
});

describe('production code does not reach into test support', () => {
  it('no production file imports a test-support module or the never-blocked guard, by any syntax', () => {
    expect(supportReaders(production)).toEqual([]);
  });

  it('no production file has a dynamic import or require the scan cannot read', () => {
    expect(unreadable(production)).toEqual([]);
  });

  it('what the production set leaves out is exactly test files and test support', () => {
    const excluded = all.filter((file) => !isProduction(file));
    expect(excluded.length).toBeGreaterThan(50);
    expect(excluded.every((file) => isTestFile(file) || file.split('/').includes('test-support') || file === 'dev/test-support.ts')).toBe(true);
    expect(excluded.length + production.size).toBe(all.length);
  });
});

describe('the scanner flags every way of referring to a module', () => {
  const cases: [string, string, ImportRef['kind']][] = [
    ['a named import', "import { issuePlan } from './plan-brand';", 'import'],
    ['a default import', "import brand from './plan-brand';", 'import'],
    ['a namespace import', "import * as brand from './plan-brand';", 'import'],
    ['double quotes', 'import { issuePlan } from "./plan-brand";', 'import'],
    ['a multi-line import', "import {\n  issuePlan,\n}\n  from\n  './plan-brand';", 'import'],
    ['a type import', "import type { Foo } from './plan-brand';", 'import'],
    ['an inline type import', "import { type Foo } from './plan-brand';", 'import'],
    ['a side-effect import', "import './plan-brand';", 'import'],
    ['a dynamic import', "const m = await import('./plan-brand');", 'dynamic-import'],
    ['a dynamic import with a template literal', 'const m = await import(`./plan-brand`);', 'dynamic-import'],
    ['a re-export of names', "export { issuePlan } from './plan-brand';", 'export-from'],
    ['a star re-export', "export * from './plan-brand';", 'export-from'],
    ['a require', "const m = require('./plan-brand');", 'require'],
    ['an import-equals require', "import m = require('./plan-brand');", 'import-equals'],
    ['an import type expression', "let x: import('./plan-brand').Foo;", 'import-type'],
  ];

  it.each(cases)('%s', (_name, text, kind) => {
    const refs = scanImports('offline/x.ts', text);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.specifier).toBe('./plan-brand');
    expect(refs[0]?.kind).toBe(kind);
  });

  it('reports the names a named import or re-export takes, and * for the syntaxes that cannot say', () => {
    expect(scanImports('x.ts', "import { issuePlan as ip, markIssued } from './plan-brand';")[0]?.names).toEqual(['issuePlan', 'markIssued']);
    expect(scanImports('x.ts', "export { issuePlan as ip } from './plan-brand';")[0]?.names).toEqual(['issuePlan']);
    for (const text of ["import * as b from './plan-brand';", "import('./plan-brand');", "export * from './plan-brand';", "require('./plan-brand');"]) {
      expect(scanImports('x.ts', text)[0]?.names).toBe('*');
    }
  });

  it('a dynamic import or require with a computed argument is reported as unreadable', () => {
    expect(scanImports('x.ts', 'await import(name);')[0]?.specifier).toBe('<non-literal>');
    expect(scanImports('x.ts', "require('./a' + b);")[0]?.specifier).toBe('<non-literal>');
  });

  it('finds a reference nested inside a function in a tsx file', () => {
    const refs = scanImports('ui/x.tsx', "export function Lazy() { return <div>{String(import('./never-blocked'))}</div>; }");
    expect(refs.map((ref) => ref.specifier)).toEqual(['./never-blocked']);
  });

  it('control: text in a comment or a string is not a reference, and a plain package import is read as one', () => {
    expect(scanImports('x.ts', "// import { issuePlan } from './plan-brand';\nconst s = \"import('./plan-brand')\";")).toEqual([]);
    expect(scanImports('x.ts', "import { describe } from 'vitest';")).toEqual([{ specifier: 'vitest', names: ['describe'], kind: 'import' }]);
  });

  it('the checks above catch a production file that does it: synthetic sources through the same functions', () => {
    const synthetic = (text: string): Map<string, ImportRef[]> => new Map([['offline/evil.ts', scanImports('offline/evil.ts', text)]]);
    const toSupport = [
      "import * as t from './test-support/brands';",
      'import { neverBlocked } from "../test-support/never-blocked";',
      "const m = await import('./test-support/purge-world');",
      "export { issuePlanForTest } from './test-support/brands';",
      "import type { X } from '../test-support/never-blocked';",
      "const m = require('./test-support/brands');",
      "import x = require('./test-support/brands');",
      "import { y } from './test-support';",
    ];
    for (const text of toSupport) expect(supportReaders(synthetic(text)), text).toEqual(['offline/evil.ts']);
    const toBrand = ["import * as b from './plan-brand';", 'import { issuePlan } from "./plan-brand";', "const b = await import('./plan-brand');", "export { markIssued } from './plan-brand';", "import type { issuePlan } from './plan-brand';", "const b = require('./plan-brand');"];
    for (const text of toBrand) expect(importers(synthetic(text), 'offline/plan-brand', ISSUING), text).toEqual(['offline/evil.ts']);
    const toAuthority = ["import * as a from './purge-authority';", 'const a = await import("./purge-authority");', "export * from './purge-authority';"];
    for (const text of toAuthority) expect(importers(synthetic(text), 'offline/purge-authority', AUTHORITY), text).toEqual(['offline/evil.ts']);
    expect(unreadable(synthetic('await import(name);'))).toEqual(['offline/evil.ts']);
  });

  it('control: a file that takes only a non-issuing name, or another module, is not an issuing importer', () => {
    const synthetic = new Map([['offline/ok.ts', scanImports('offline/ok.ts', "import { isIssuedPlan } from './plan-brand';\nimport { x } from './other';")]]);
    expect(importers(synthetic, 'offline/plan-brand', ISSUING)).toEqual([]);
    expect(importers(synthetic, 'offline/plan-brand', [])).toEqual(['offline/ok.ts']);
    expect(supportReaders(synthetic)).toEqual([]);
  });
});
