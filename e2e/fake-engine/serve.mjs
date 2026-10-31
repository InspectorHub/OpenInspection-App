#!/usr/bin/env node
// Standalone fake engine for native E2E: Electron, Android emulator (10.0.2.2) and iOS simulator (localhost).
// Plain Node >= 22.18 (built-in TypeScript type stripping), no build step, no dependencies.
//
//   node e2e/fake-engine/serve.mjs [--host 127.0.0.1] [--port 0] [--scenario default|inspection] [--upload-delay-ms N]
//
// Prints exactly one JSON line on stdout when ready: {"origin":"http://host:port","control":"http://127.0.0.1:port"}
// (origin uses 127.0.0.1 when bound to 0.0.0.0; the emulator reaches the same server as http://10.0.2.2:port).
// Test-only controls live on the separate loopback `control` origin under /__test__/ (see control.ts).
// SIGINT/SIGTERM close both servers and exit 0.
import { parseArgs } from 'node:util';

// The engine and control modules are TypeScript; Node strips types natively from 22.18. Check before importing them.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`fake engine needs Node >= 22.18 (built-in TypeScript type stripping); this is ${process.versions.node}
`);
  process.exit(2);
}
const { startRendererEngine, scenarios } = await import('./engine.ts');
const { startControlServer } = await import('./control.ts');

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    scenario: { type: 'string', default: 'default' },
    'upload-delay-ms': { type: 'string', default: '0' },
  },
});

const scenario = scenarios[values.scenario];
if (scenario === undefined) {
  process.stderr.write(`unknown scenario "${values.scenario}"; known: ${Object.keys(scenarios).join(', ')}\n`);
  process.exit(2);
}
const port = Number(values.port);
const uploadDelayMs = Number(values['upload-delay-ms']);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(uploadDelayMs) || uploadDelayMs < 0) {
  process.stderr.write('invalid --port or --upload-delay-ms\n');
  process.exit(2);
}

if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(values.host)) {
  process.stderr.write(`WARNING: --host ${values.host} exposes an unauthenticated fake engine (fixed bearer token) to the network. Use it on a trusted network only.
`);
}

const engine = await startRendererEngine({ ...scenario, host: values.host, port, uploadDelayMs });
const control = await startControlServer(engine);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.all([engine.close(), control.close()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

process.stdout.write(`${JSON.stringify({ origin: engine.url, control: control.origin })}\n`);
