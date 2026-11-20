/**
 * IPC glue for the desktop-owned import runner (A-6/A-7). The renderer supplies
 * only a server URL, credentials, a local FILE PATH and a re-entered password —
 * never package bytes, never a step-up token. Main reads the file, mints the
 * step-up token(s), owns the power-save guard, and pushes small progress events.
 */
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDataPackageHttp, createNodeDataPackageTransport, type DataPackageHttp, type RawResponse, type OutgoingBody } from './http';
import { dataPackageEndpoints } from './config';
import { runImport, runRevert, type ImportRunnerDeps, type ImportResult } from './importer';
import type { DataPackageStateHost } from './state';
import type { ProgressFn } from './types';

export interface ImportHostDeps {
  readonly state: DataPackageStateHost;
  readonly onProgress: ProgressFn;
  readonly log: (line: string) => void;
  readonly redact: (text: string) => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Injected for tests; production uses createNodeDataPackageTransport. */
  readonly transport?: (req: {
    url: string; method: string; headers: Record<string, string>;
    timeoutMs: number; maxBytes: number; signal: AbortSignal; body?: OutgoingBody;
  }) => Promise<RawResponse>;
  /** Acquire/release the OS power-save guard around the run. */
  readonly power?: { acquire(): { release(): void } };
}

export interface StartImportRequest {
  readonly serverUrl: string;
  readonly bearer: string;
  readonly stepUpPassword: string;
  readonly stepUpCode?: string;
  readonly deviceLabel: string;
  readonly clientKind: string;
  readonly packagePath: string;
}

function originOf(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.origin !== serverUrl.replace(/\/$/, '') || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('invalid-server-url');
  return url.origin;
}

/** Exchange a password for a one-time step-up token on the native path. */
async function stepUp(http: DataPackageHttp, origin: string, bearer: string, action: string, password: string, code?: string): Promise<string> {
  const res = await http.request({
    url: `${origin}/api/auth/step-up`, method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, password, ...(code ? { code } : {}), nativeClient: true }),
  });
  if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) throw new Error('step-up-failed');
  const token = (res.json as { data?: { token?: unknown } }).data?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('step-up-token');
  return token;
}

async function readWholeFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) throw new Error('package-too-large');
    const buffer = await handle.readFile(); // Buffer (fs.promises FileHandle)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    await handle.close();
  }
}

function runnerDeps(deps: ImportHostDeps, http: DataPackageHttp, req: StartImportRequest): ImportRunnerDeps {
  const origin = originOf(req.serverUrl);
  return {
    http, endpoints: dataPackageEndpoints(origin), bearer: req.bearer,
    state: deps.state, now: deps.now, sleep: deps.sleep, log: deps.log,
    readPackage: () => readWholeFile(req.packagePath, 4 * 1024 * 1024 * 1024),
    // Separate media volume files are resolved relative to the package file.
    readVolume: async (name) => {
      const dir = dirname(req.packagePath);
      try { return await readWholeFile(join(dir, name), 4 * 1024 * 1024 * 1024); }
      catch { return undefined; }
    },
    // Fresh token per action/call: engine step-up tokens are single-use and
    // action-bound, so create-job (data-export-start) and each privileged write
    // (data-import-apply) each need their own.
    stepUp: (action) => stepUp(http, origin, req.bearer, action, req.stepUpPassword, req.stepUpCode),
  };
}

/** Import a package from a renderer request. */
export async function startImportFromRenderer(deps: ImportHostDeps, req: StartImportRequest): Promise<ImportResult> {
  const transport = deps.transport ?? createNodeDataPackageTransport();
  const http = createDataPackageHttp({ request: (r) => transport(r), log: deps.log, redact: deps.redact });
  const release = deps.power?.acquire();
  try {
    return await runImport(runnerDeps(deps, http, req), {
      deviceLabel: req.deviceLabel, clientKind: req.clientKind, onProgress: deps.onProgress,
    });
  } finally {
    release?.release();
  }
}

/** Import then revert — used by the E2E harness to exercise the irreversible revert flow. */
export async function revertImportFromRenderer(deps: ImportHostDeps, req: StartImportRequest): Promise<void> {
  const origin = originOf(req.serverUrl);
  const transport = deps.transport ?? createNodeDataPackageTransport();
  const http = createDataPackageHttp({ request: (r) => transport(r), log: deps.log, redact: deps.redact });
  const runner = runnerDeps(deps, http, req);
  // Keep the job live (no complete/state-clear) so revert has an active lease.
  const imported = await runImport(runner, {
    deviceLabel: req.deviceLabel, clientKind: req.clientKind,
    onProgress: deps.onProgress, skipComplete: true,
  });
  // Each revert step needs a FRESH token (single-use). Mint one per call.
  await runRevert(runner, imported.jobId, imported.jobToken, async () =>
    stepUp(http, origin, req.bearer, 'data-import-revert', req.stepUpPassword, req.stepUpCode));
  await deps.state.clear();
}
