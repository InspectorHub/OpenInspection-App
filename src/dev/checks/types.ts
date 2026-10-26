import type { AppServices } from '../../app/compose';
import type { TimerPort } from '../../collab/timers';
import type { Network } from '../../platform/network';
import type { UploaderPluginLike } from '../../platform/uploader';

/** Every title starts with this marker; the release-bundle check refuses it, so a title can never ship. */
export const TITLE_MARKER = '[diag]';

export type CheckStatus = 'pass' | 'fail' | 'needs_sign_in' | 'needs_input';

export interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  status: CheckStatus;
  /** Fixed words and numbers only: never a token, a url, a path with an id, or text the server sent. */
  detail: string;
}

/** What a closed WebSocket attempt looked like, without the address. */
export interface SocketProbe {
  opened: boolean;
  /** Close code, or null when the socket never closed within the wait. */
  closeCode: number | null;
  /** Set when the constructor itself threw (an error name, never its message). */
  threw: string | null;
}

/** The pieces of the page and the plugins the checks touch directly; tests replace them with fakes. */
export interface DiagPorts {
  /** Raw answer of the filesystem plugin's stat for a path that does not exist: null when it unexpectedly succeeded. */
  statMissing(path: string): Promise<{ code: string | null; message: string } | null>;
  /** Resolves true when an image loads from `url` within `timeoutMs`. */
  loadImage(url: string, timeoutMs: number): Promise<boolean>;
  storageEstimate(): Promise<{ usage: number | null; quota: number | null } | null>;
  /** `granted`, `denied`, `default`, or `unknown` when the WebView has no Notification API. */
  notificationPermission(): string;
  /** Opens a raw WebSocket to `url` and reports what happened within `waitMs`. */
  probeSocket(url: string, waitMs: number): Promise<SocketProbe>;
  timers: TimerPort;
  /** Used for ids and filler bytes only. */
  random(): number;
}

/** The real device adapters a check composes with; the screen supplies the real ones. */
export interface DiagDeps {
  ports: DiagPorts;
  uploaderPlugin: UploaderPluginLike;
  network: Network;
}

export interface DiagContext {
  services: AppServices;
  /** The signed-in server origin, or null on the setup screen. */
  origin: string | null;
  /** The inspection id typed by the operator; empty when none. */
  inspectionId: string;
  deps: DiagDeps;
  /** Publishes an intermediate result for a check that keeps running (the kill test counter). */
  emit(result: CheckResult): void;
}

export interface CheckDef {
  id: string;
  title: string;
  /** Short operator note shown under the button. */
  hint: string;
  run(ctx: DiagContext): Promise<CheckResult>;
}

/** An action that belongs to a check but is run on its own button and is not part of "Run all". */
export interface ExtraDef extends CheckDef {
  parent: string;
  /** The text of its button. */
  label: string;
}

export function pass(def: { id: string; title: string }, detail: string): CheckResult {
  return { id: def.id, title: def.title, ok: true, status: 'pass', detail };
}

export function fail(def: { id: string; title: string }, detail: string): CheckResult {
  return { id: def.id, title: def.title, ok: false, status: 'fail', detail };
}

export function needsSignIn(def: { id: string; title: string }): CheckResult {
  return { id: def.id, title: def.title, ok: false, status: 'needs_sign_in', detail: 'needs sign-in' };
}

export function needsInput(def: { id: string; title: string }): CheckResult {
  return { id: def.id, title: def.title, ok: false, status: 'needs_input', detail: 'needs inspection id' };
}

/** A fixed word for a thrown value: its error name, or a constant. Never the message, which may carry a url or a path. */
export function errorWord(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { name } = error as { name?: unknown };
    if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name;
  }
  return 'Error';
}

/** Deterministic filler: the same bytes every run, so a comparison failure is reproducible. */
export function fillerBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = (seed | 0) || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Index of the first differing byte (or the shorter length when only the lengths differ); -1 when equal. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

/** Wraps a check body: an unexpected throw becomes one fixed failing line instead of an unhandled rejection. */
export async function guarded(def: { id: string; title: string }, body: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await body();
  } catch (error) {
    return fail(def, `threw ${errorWord(error)}`);
  }
}
