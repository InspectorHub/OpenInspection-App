import { loadIdentity } from '../auth/server-config';
import { loadTenantName } from '../offline/lock-state';
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
}

export interface RunOptions {
  includeQuarantined: boolean;
  /** Export only these inspections (the export offered on a quarantined row). */
  only?: readonly string[] | undefined;
  /** The `confirmed` of the preflight the person saw. */
  confirmed: boolean;
}

export type ExportFailure = 'not_signed_in' | 'build_failed' | 'share_failed';

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
  /** The cache file could not be deleted; it is swept at the next start. */
  leftover: boolean;
}

export type ExportOutcome = ExportDone | { kind: 'nothing' } | { kind: 'busy' } | { kind: 'failed'; code: ExportFailure };

export interface Exporter {
  /** Sweeps old export files, runs the reconcile when there is one, and counts. Writes nothing to the database. */
  prepare(): Promise<Preflight>;
  /** Builds the archive into the cache, opens the share sheet, and deletes the archive when it returns. One at a time. */
  run(options: RunOptions): Promise<ExportOutcome>;
}

/** One export runs at a time in the whole app, however many exporters were built. Released in `finally`. */
let running = false;

async function identityOf(db: Db): Promise<ExportIdentity | null> {
  const stored = await loadIdentity(db);
  if (stored === null) return null;
  if (!PACKAGE_ID_PATTERN.test(stored.tenantId) || !PACKAGE_ID_PATTERN.test(stored.userId)) return null;
  return { tenantId: stored.tenantId, userId: stored.userId };
}

export function createExporter(deps: ExporterDeps): Exporter {
  async function prepare(): Promise<Preflight> {
    await sweepStaleExports(deps.files, deps.clock.now(), 0);
    const identity = await identityOf(deps.db);
    const confirmed = deps.reconcile === undefined ? false : await deps.reconcile().catch(() => false);
    const company = await loadTenantName(deps.db).catch(() => null);
    if (identity === null) return { confirmed, included: 0, quarantined: 0, company };
    const plan = await collectPlan(deps.db, identity, { includeQuarantined: true });
    return { confirmed, included: plan.unquarantinedHolding, quarantined: plan.quarantinedHolding, company };
  }

  async function exportNow(options: RunOptions): Promise<ExportOutcome> {
    // Nothing is running (one at a time), so every archive of ours still in the cache is from an earlier run.
    await sweepStaleExports(deps.files, deps.clock.now(), 0);
    const identity = await identityOf(deps.db);
    if (identity === null) return { kind: 'failed', code: 'not_signed_in' };

    const startedAt = deps.clock.now();
    const plan = await collectPlan(deps.db, identity, { includeQuarantined: options.includeQuarantined, only: options.only });
    if (plan.inspections.length === 0) return { kind: 'nothing' };

    const built = buildPackage(plan, { db: deps.db, files: deps.files, exportedAt: new Date(startedAt).toISOString() });
    let shared: Awaited<ReturnType<typeof writeAndShare>>;
    try {
      shared = await writeAndShare({ files: deps.files, sharer: deps.sharer }, exportFileName(startedAt), built.chunks);
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
