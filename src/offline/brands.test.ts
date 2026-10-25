import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The issuer brand of a plan and the purge authority are conventions the compiler cannot enforce on their own: any module
 * could import them. So the set of modules that may is pinned here, and a new importer fails this test until a person
 * decides it belongs on the list.
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

function importers(module: string, names: string[]): string[] {
  const pattern = new RegExp(String.raw`import\s*\{[^}]*\b(?:${names.join('|')})\b[^}]*\}\s*from\s*'[^']*${module}'`);
  return sources(SRC).filter((file) => !file.endsWith(`${module}.ts`) && pattern.test(readFileSync(join(SRC, file), 'utf8')));
}

describe('who may use the brands', () => {
  it('only the decision and the test support may issue a plan', () => {
    expect(importers('plan-brand', ['issuePlan', 'markIssued'])).toEqual(['offline/reconcile-decision.ts', 'offline/test-support/brands.ts']);
  });

  it('only the person-confirmed actions, the purge itself and the test support may take the purge authority', () => {
    expect(importers('purge-authority', ['purgeAuthority'])).toEqual(['offline/purge.ts', 'offline/test-support/brands.ts', 'offline/user-actions.ts']);
  });

  it('the scan sees what it is looking for: the files that are allowed are found by the same pattern', () => {
    expect(importers('plan-brand', ['isIssuedPlan']).length).toBeGreaterThan(0);
  });
});
