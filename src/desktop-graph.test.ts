import { describe, expect, it } from 'vitest';
import { importGraph } from './test-support/import-graph';

// The desktop entry must reach no Capacitor module: the desktop client has no native plugins to call. The Android entry
// is the control: the same walk from it has to find Capacitor, or the walk proves nothing.
const capacitorFilesFrom = (entry: string): string[] => [...new Set(importGraph(entry).packages.filter((ref) => ref.specifier.startsWith('@capacitor') || ref.specifier.startsWith('@capgo/') || ref.specifier.startsWith('@aparajita/')).map((ref) => ref.file))].sort();

describe('the desktop import graph', () => {
  it('walks a real set of files from both entries (an empty walk would pass vacuously)', () => {
    expect(importGraph('src/App.tsx').files.size).toBeGreaterThan(100);
    expect(importGraph('src/main.tsx').files.size).toBeGreaterThan(100);
  });

  it('control: the Android entry reaches Capacitor', () => {
    expect(capacitorFilesFrom('src/main.tsx').length).toBeGreaterThan(0);
  });

  it('src/App.tsx reaches no Capacitor module', () => {
    expect(capacitorFilesFrom('src/App.tsx')).toEqual([]);
  });
});
