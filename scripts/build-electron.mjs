import { mkdir } from 'node:fs/promises';
import { build, context } from 'esbuild';

// The main process and the sandboxed preload script must be CommonJS. The target is the Node major of the pinned
// Electron (see "Windows (Electron)" in docs/development.md); native modules stay external and load from node_modules.
const NODE_TARGET = 'node24';
const entries = { main: 'electron/main/index.ts', preload: 'electron/preload/index.ts' };

const watch = process.argv.includes('--watch');
const contexts = [];
for (const [name, entry] of Object.entries(entries)) {
  await mkdir(`dist-electron/${name}`, { recursive: true });
  const options = {
    entryPoints: [entry],
    outfile: `dist-electron/${name}/index.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: NODE_TARGET,
    external: ['electron', 'better-sqlite3-multiple-ciphers'],
    sourcemap: true,
    logLevel: 'info',
  };
  if (watch) contexts.push(await context(options));
  else await build(options);
}
if (watch) await Promise.all(contexts.map((ctx) => ctx.watch()));
