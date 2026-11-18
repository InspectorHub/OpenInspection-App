/**
 * Main-process export host (A-3 glue): builds the restricted http client,
 * obtains a step-up token for `data-export-start`, runs the export and pushes
 * progress events to the renderer. Secrets are passed in from the renderer
 * over IPC for this one action and held only in memory for the run.
 */
import { createDataPackageHttp, createNodeDataPackageTransport, type DataPackageHttp, type RawResponse } from './http';
import { dataPackageEndpoints, type DataPackageEndpoints } from './config';
import { runExport, type ExportRunnerDeps, type ExportResult, type StartExportOptions } from './exporter';
import type { DataPackageStateHost } from './state';
import type { ExportFs, ProgressFn } from './types';

export interface ExportHostDeps {
  readonly state: DataPackageStateHost;
  readonly files: ExportFs;
  readonly baseDir: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly onProgress: ProgressFn;
  readonly redact: (text: string) => string;
  /** Injected for tests; production uses createNodeDataPackageTransport. */
  readonly transport?: (req: {
    url: string; method: string; headers: Record<string, string>;
    timeoutMs: number; maxBytes: number; signal: AbortSignal; body?: string;
  }) => Promise<RawResponse>;
}

export interface StartExportRequest {
  readonly serverUrl: string;
  readonly bearer: string;
  readonly stepUpPassword: string;
  readonly stepUpCode?: string;
  readonly deviceLabel: string;
  readonly clientKind: string;
}

function originOf(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.origin !== serverUrl.replace(/\/$/, '') || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('invalid-server-url');
  return url.origin;
}

/** Exchange a re-entered password for a one-time step-up token on the native path. */
async function obtainStepUpToken(http: DataPackageHttp, origin: string, bearer: string, password: string, code?: string): Promise<string> {
  const res = await http.request({
    url: `${origin}/api/auth/step-up`, method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'data-export-start', password,
      ...(code ? { code } : {}),
      nativeClient: true,
    }),
  });
  if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) throw new Error('step-up-failed');
  const data = (res.json as { data?: { token?: unknown } }).data;
  const token = data?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('step-up-token');
  return token;
}

/** Run one export from a renderer request. Returns the attested result. */
export async function startExportFromRenderer(deps: ExportHostDeps, req: StartExportRequest): Promise<ExportResult> {
  const origin = originOf(req.serverUrl);
  const transport = deps.transport ?? createNodeDataPackageTransport();
  const http = createDataPackageHttp({
    request: (r) => transport(r),
    log: deps.log, redact: deps.redact,
  });
  const endpoints: DataPackageEndpoints = dataPackageEndpoints(origin);
  const credentials = { bearer: req.bearer, jobToken: '' };
  const stepUpToken = await obtainStepUpToken(http, origin, req.bearer, req.stepUpPassword, req.stepUpCode);

  const runner: ExportRunnerDeps = {
    http, endpoints, credentials, state: deps.state, files: deps.files,
    baseDir: deps.baseDir, now: deps.now, sleep: deps.sleep, log: deps.log,
    binaryGet: async (r) => {
      const raw = await transport({
        url: r.url, method: 'GET', headers: r.headers,
        timeoutMs: 60_000, maxBytes: r.maxBytes, signal: new AbortController().signal,
      });
      if (raw.body.byteLength > r.maxBytes) throw new Error('object-too-large');
      return { status: raw.status, bytes: new Uint8Array(raw.body) };
    },
  };

  const opts: StartExportOptions = {
    deviceLabel: req.deviceLabel, clientKind: req.clientKind, stepUpToken,
    originHost: new URL(origin).hostname, onProgress: deps.onProgress,
  };
  try {
    return await runExport(runner, opts);
  } catch (error) {
    // A failed/cancelled export must not strand the server-side lease. The
    // job id lives in the checkpoint (which runExport clears only on success).
    try {
      const checkpoint = await deps.state.load();
      const jobId = checkpoint?.jobId;
      if (jobId && credentials.jobToken) {
        await http.request({
          url: endpoints.abort(jobId), method: 'POST',
          headers: { Authorization: `Bearer ${req.bearer}`, 'X-Data-Job': credentials.jobToken },
        });
      }
      // The aborted/failed job must not be resumed on the next start: the
      // server has freed its lease and may refuse a resume. Clear the local
      // checkpoint so the next run creates a fresh job.
      await deps.state.clear();
    } catch { /* best effort: the engine also expires leases on TTL */ }
    throw error;
  }
}
