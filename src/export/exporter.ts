import { loadIdentity } from '../auth/server-config';
import { loadTenantName } from '../offline/lock-state';
import type { ClientPlatform } from '../app/compose';
import type { TimerPort } from '../collab/timers';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { buildPackage } from './build-package';
import { collectPlan, type ExportIdentity, type OmittedCounts } from './collect';
import { PACKAGE_ID_PATTERN, exportFileName } from './format';
import type { ReconcileGate } from './reconcile-gate';
import { writeAndShare, type Sharer } from './share-package';
import { sweepStaleExports } from './sweep';

/** The part of the file layer an export uses. */
export type ExportFilesPort = Pick<Files, 'read' | 'writeCacheChunks' | 'removeCache' | 'listCache'>;

export interface ExporterDeps {
  db: Db;
  files: ExportFilesPort;
  clock: Clock;
  sharer: Sharer;
  /** Decides when the archive is deleted: at once on iOS, after a bound on Android (see `writeAndShare`). */
  platform: ClientPlatform;
  /** Schedules the delayed deletion on Android. Defaults to the page's timers. */
  timers?: TimerPort | undefined;
  /**
   * Asks the server which inspections still exist. Absent where no session runs (the lock screen): the export then goes ahead
   * and says the list could not be confirmed.
   */
  reconcile?: ReconcileGate | undefined;
}

/** What the person is shown before choosing. */
export interface Preflight {
  /** The server confirmed the list of inspections just now. False for every other reason, including having no way to ask. */
  confirmed: boolean;
  /** Inspections that would be exported by default. */
  included: number;
  /** Quarantined inspections that hold something and would be exported only on request. */
  quarantined: number;
  /** The company's name for the responsibility sentence, or null when it is not known. */
  company: string | null;
  /** Exported inspections the importer may refuse for want of a report id (no create in the package). */
  reportIdUnknown: number;
  /** The inspections that would be exported by default, for `run` to notice changes since. */
  ids: string[];
}

export interface RunOptions {
  includeQuarantined: boolean;
  /** Export only these inspections (the export offered on a quarantined row). */
  only?: readonly string[] | undefined;
  /** The `confirmed` of the preflight the person saw. */
  confirmed: boolean;
  /** The `ids` of that preflight: inspections that are no longer exportable when the archive is built are counted, not hidden. */
  expected?: readonly string[] | undefined;
}

export type ExportFailure = 'not_signed_in' | 'invalid_account' | 'build_failed' | 'share_failed';

export interface ExportDone {
  kind: 'shared' | 'cancelled';
  inspections: number;
  photos: number;
  writes: number;
  /** The list could not be confirmed, so the receiving office may refuse some inspections. */
  unconfirmed: boolean;
  /** Photos that were in the plan and could not be put in the package. */
  photosMissing: number;
  omitted: OmittedCounts;
  /** The cache file could not be deleted when it should have been; it is swept at the next start. */
  leftover: boolean;
  /** The cache file was left on purpose (Android) and goes within `EXPORT_RETAIN_MS`. */
  kept: boolean;
  /** Inspections the person saw in the preflight that were purged, quarantined or emptied before the archive was built. */
  changedSincePrepare: number;
}

export type ExportOutcome = ExportDone | { kind: 'nothing'; changedSincePrepare?: number } | { kind: 'busy' } | { kind: 'failed'; code: ExportFailure };

export interface Exporter {
  /**
   * Sweeps old export files, runs the reconcile when there is one, and counts. The reconcile is the app's own flow and may
   * quarantine or purge inspections by its own rules; that is the only thing here that can change the database. `run` and the
   * archive build never write to it.
   */
  prepare(): Promise<Preflight>;
  /** Builds the archive into the cache, opens the share sheet, and deletes the archive when it returns. One at a time. */
  run(options: RunOptions): Promise<ExportOutcome>;
}

/** One export runs at a time in the whole app, however many exporters were built. Released in `finally`. */
let running = false;

type IdentityResult = { kind: 'ok'; identity: ExportIdentity } | { kind: 'missing' } | { kind: 'invalid' };

/** The engine refuses a manifest whose tenant or user id is outside its id pattern, so such an account cannot be exported for. */
async function identityOf(db: Db): Promise<IdentityResult> {
  const stored = await loadIdentity(db);
  if (stored === null) return { kind: 'missing' };
  if (!PACKAGE_ID_PATTERN.test(stored.tenantId) || !PACKAGE_ID_PATTERN.test(stored.userId)) return { kind: 'invalid' };
  return { kind: 'ok', identity: { tenantId: stored.tenantId, userId: stored.userId } };
}

export function createExporter(deps: ExporterDeps): Exporter {
  async function prepare(): Promise<Preflight> {
    await sweepStaleExports(deps.files, deps.clock.now(), 0);
    const found = await identityOf(deps.db);
    const confirmed = deps.reconcile === undefined ? false : await deps.reconcile().catch(() => false);
    const company = await loadTenantName(deps.db).catch(() => null);
    if (found.kind !== 'ok') return { confirmed, included: 0, quarantined: 0, company, reportIdUnknown: 0, ids: [] };
    const plan = await collectPlan(deps.db, found.identity, { includeQuarantined: false });
    return { confirmed, included: plan.inspections.length, quarantined: plan.quarantinedHolding, company, reportIdUnknown: plan.omitted.reportIdUnknown, ids: plan.inspections.map((row) => row.id) };
  }

  async function exportNow(options: RunOptions): Promise<ExportOutcome> {
    // Nothing is running (one at a time), so every archive of ours still in the cache is from an earlier run.
    await sweepStaleExports(deps.files, deps.clock.now(), 0);
    const found = await identityOf(deps.db);
    if (found.kind === 'missing') return { kind: 'failed', code: 'not_signed_in' };
    if (found.kind === 'invalid') return { kind: 'failed', code: 'invalid_account' };
    const identity = found.identity;

    const startedAt = deps.clock.now();
    const plan = await collectPlan(deps.db, identity, { includeQuarantined: options.includeQuarantined, only: options.only });
    const taken = new Set(plan.inspections.map((row) => row.id));
    const changedSincePrepare = (options.expected ?? []).filter((id) => !taken.has(id)).length;
    if (plan.inspections.length === 0) return changedSincePrepare > 0 ? { kind: 'nothing', changedSincePrepare } : { kind: 'nothing' };

    const built = buildPackage(plan, { db: deps.db, files: deps.files, exportedAt: new Date(startedAt).toISOString() });
    let shared: Awaited<ReturnType<typeof writeAndShare>>;
    try {
      shared = await writeAndShare({ files: deps.files, sharer: deps.sharer, platform: deps.platform, timers: deps.timers }, exportFileName(startedAt), built.chunks);
    } catch (error) {
      return { kind: 'failed', code: error instanceof Error && error.name === 'ShareFailed' ? 'share_failed' : 'build_failed' };
    }
    const summary = built.summary();
    return {
      kind: shared.result,
      inspections: plan.inspections.length,
      photos: summary.photosIncluded,
      writes: plan.outbox.length,
      unconfirmed: !options.confirmed,
      photosMissing: summary.photosMissing,
      omitted: plan.omitted,
      leftover: shared.leftover,
      kept: shared.kept,
      changedSincePrepare,
    };
  }

  return {
    prepare,
    run: async (options) => {
      if (running) return { kind: 'busy' };
      running = true;
      try {
        return await exportNow(options);
      } catch {
        return { kind: 'failed', code: 'build_failed' };
      } finally {
        running = false;
      }
    },
  };
}
