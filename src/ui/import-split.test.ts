import { describe, expect, it } from 'vitest';
import { importGraph } from '../test-support/import-graph';

// The import screen pulls in the shared offline-package reader (and, through it, zod). It is a chunk of its own, loaded when
// Settings opens the import, so neither may be reachable through the static imports of the screens that are always loaded.
const SCREEN = 'src/ui/import/ImportScreen.tsx';
const HEAVY = ['@inspectorhub/offline-package', 'zod'];

const heavyFrom = (entry: string, options: { followDynamic?: boolean } = {}): string[] =>
  [...new Set(importGraph(entry, options).packages.map((ref) => ref.specifier).filter((s) => HEAVY.includes(s)))].sort();

describe('the import screen is split from the main chunk', () => {
  it('walks real graphs (an empty walk would pass vacuously)', () => {
    expect(importGraph('src/ui/SignedIn.tsx').files.size).toBeGreaterThan(30);
    expect(importGraph('src/App.tsx').files.size).toBeGreaterThan(100);
  });

  it.each(['src/ui/SignedIn.tsx', 'src/App.tsx', 'src/main.tsx', 'src/main-electron.tsx'])('%s reaches neither the import screen nor the offline-package reader nor zod', (entry) => {
    expect(importGraph(entry).files.has(SCREEN)).toBe(false);
    expect(heavyFrom(entry)).toEqual([]);
  });

  it('control: the import screen itself reaches the reader, and following the dynamic import from SignedIn reaches the screen', () => {
    expect(heavyFrom(SCREEN)).toContain('@inspectorhub/offline-package');
    expect(importGraph('src/ui/SignedIn.tsx', { followDynamic: true }).files.has(SCREEN)).toBe(true);
    expect(heavyFrom('src/ui/SignedIn.tsx', { followDynamic: true })).toContain('@inspectorhub/offline-package');
  });
});
