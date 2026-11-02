import {
  IMPORT_LIMIT_CEILINGS,
  readPackageSummary,
  runImport,
  type ImportOptions,
  type ImportReport,
  type PackageSummary,
  type Send,
  type SendResult,
} from '@inspectorhub/offline-package';
import type { Api } from '../field/api-client';

/**
 * Importing an offline package from this device: the transport behind the shared import, and the one function the screen calls.
 *
 * `runImport` (the shared package) does the reading, the cutting into parts, the strictly serial sending and the sorting of every
 * inspection into imported or held back. This module supplies the one thing it cannot: how a part reaches the server. That is
 * the app's authenticated client (Bearer token, pinned origin, no redirects), so the work is done as the signed-in person.
 *
 * The contract with `runImport`: a refusal is a RESULT, and only a request that got no answer at all rejects (it is then sent
 * again, which is safe because an import is idempotent). There is one more kind of answer-less outcome that must NOT be retried:
 * the sign-in is over, the device is locked, or the app or the server is too old. Retrying those five times over five minutes
 * would only leave the person looking at "Importing" for nothing, so such a problem is remembered, every later send fails at once
 * without touching the network, and the caller reports the reason instead of a list of unconfirmed inspections.
 */

export const IMPORT_PATH = '/api/client/import';

/** Why an import was stopped rather than retried. */
export type StopProblem = 'auth' | 'locked' | 'upgrade' | 'server_too_old';

const STOP_PROBLEMS: ReadonlySet<string> = new Set<StopProblem>(['auth', 'locked', 'upgrade', 'server_too_old']);

/** Allowance for the server to answer once the last byte has arrived, and the floor for any package. */
export const MIN_SEND_TIMEOUT_MS = 60_000;
export const MAX_SEND_TIMEOUT_MS = 10 * 60_000;
/** A conservative field uplink: 100 KiB/s, so 24 MiB is allowed about four minutes on top of the floor. */
const ASSUMED_UPLINK_BYTES_PER_SECOND = 100 * 1024;
/** Longest piece of a non-JSON answer kept, so a gateway page cannot fill memory. */
const MAX_TEXT_BODY_CHARS = 2000;

/** Time allowed for one request: the floor plus the time `bytes` take at the assumed uplink, capped. */
export function defaultSendTimeoutMs(bytes: number): number {
  const transfer = (bytes / ASSUMED_UPLINK_BYTES_PER_SECOND) * 1000;
  return Math.min(MAX_SEND_TIMEOUT_MS, MIN_SEND_TIMEOUT_MS + Math.ceil(transfer));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Code and details from the server's `{ error: { code, details } }` shape, when the body has one. */
function errorFieldsOf(body: unknown): Pick<SendResult, 'code' | 'details'> {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  const { code, details } = body.error;
  return { ...(typeof code === 'string' ? { code } : {}), ...(details !== undefined ? { details } : {}) };
}

export interface ImportSend {
  send: Send;
  /** The problem that stopped the import, or null while none has. */
  stopped(): StopProblem | null;
  /**
   * Inspections in a part whose request was handed to the network at least once. Such a request may have been applied even though no
   * answer came back, so an inspection in it is "not confirmed", never "not sent".
   */
  requested(): ReadonlySet<string>;
}

export function createImportSend(api: Pick<Api, 'send'>): ImportSend {
  let stopped: StopProblem | null = null;
  const requested = new Set<string>();

  function idsIn(bytes: Uint8Array): string[] {
    try {
      return readPackageSummary(bytes).manifest.inspections.map((i) => i.id);
    } catch {
      return [];
    }
  }

  const send: Send = async (bytes) => {
    if (stopped !== null) throw new Error('import stopped');
    const max = IMPORT_LIMIT_CEILINGS.compressedBytes;
    // The server answers 413 for this without reading it; do not upload what cannot be accepted.
    if (bytes.byteLength > max) return { status: 413, code: 'PACKAGE_TOO_LARGE', details: { limit: 'compressedBytes', max, actual: bytes.byteLength } };
    const ids = idsIn(bytes);
    const outcome = await api.send({
      method: 'POST',
      path: IMPORT_PATH,
      bytes,
      contentType: 'application/zip',
      timeoutMs: defaultSendTimeoutMs(bytes.byteLength),
      keepText: true,
    });
    // A stopping problem is raised before anything is sent (or is the server refusing to look at it); every other outcome means the
    // request went out, whether or not an answer came back.
    const stoppedBefore = outcome.kind === 'problem' && STOP_PROBLEMS.has(outcome.problem);
    if (!stoppedBefore) for (const id of ids) requested.add(id);
    if (outcome.kind === 'problem') {
      if (stoppedBefore) stopped = outcome.problem as StopProblem;
      // No answer arrived (or none may be asked for): the shared import decides whether to send the part again.
      throw new Error(`import request had no answer: ${outcome.problem}`);
    }
    if (outcome.json === undefined) {
      // Not JSON (a proxy or gateway page): keep a bounded piece and let the classifier decide from the status.
      return { status: outcome.status, body: (outcome.text ?? '').slice(0, MAX_TEXT_BODY_CHARS) };
    }
    return { status: outcome.status, ...errorFieldsOf(outcome.json), body: outcome.json };
  };

  return { send, stopped: () => stopped, requested: () => requested };
}

export interface ImportDeps {
  api: Pick<Api, 'send'>;
  /** Waits between retries. Defaults to the page's timers. */
  sleep?: ImportOptions['sleep'];
  now?: ImportOptions['now'];
  /** Resolves once the screen has drawn a frame. Defaults to one animation frame, with a short timer as a fallback. */
  nextFrame?: () => Promise<void>;
}

export interface ImportOutcome {
  report: ImportReport;
  /** Set when the import was stopped by a problem retrying cannot cure; the inspections not yet confirmed are in `report.heldBack`. */
  stopped: StopProblem | null;
  /** Inspections whose part was sent at least once (see `ImportSend.requested`). */
  requested: ReadonlySet<string>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A hidden page may never get an animation frame, so the wait is bounded: the import must not hang on it. */
export const realNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    const fallback = setTimeout(resolve, 100);
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    });
  });

/**
 * Sends the package. Rejects only for a package the shared reader cannot read (nothing was sent). The unpacking runs on the
 * page's thread and can take a moment on a slow phone, so the screen is given a frame to show "Importing" first.
 */
export async function importPackage(zip: Uint8Array, deps: ImportDeps, onProgress?: ImportOptions['onProgress']): Promise<ImportOutcome> {
  const transport = createImportSend(deps.api);
  const sleep = deps.sleep ?? realSleep;
  await (deps.nextFrame ?? realNextFrame)();
  const report = await runImport(zip, transport.send, {
    // After a stop every remaining send fails at once, so the shared import's waits would only delay the answer.
    sleep: (ms) => (transport.stopped() === null ? sleep(ms) : Promise.resolve()),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  return { report, stopped: transport.stopped(), requested: transport.requested() };
}

/** Whether the package was exported for the company this device is signed in to. Only ever compared, never trusted as an identity. */
export function tenantMatches(summary: PackageSummary, tenantId: string): boolean {
  return tenantId !== '' && summary.manifest.tenantId === tenantId;
}
