import type { CompliancePanelData, EditorData, EditorInspection, UnitProgress } from '@inspectorhub/field-ui';
import type { IsBlocked } from '../offline/blocked';
import { accountKey, listOutbox, sameAccount, type Account } from '../offline/outbox';
import { readCachedBodies, type CachedResource } from '../offline/resource-cache';
import { EDITOR_READ_KEY_MAP, GLOBAL_RESOURCE_PATHS } from '../offline/resources';
import { isLocalId } from '../offline/registry';
import type { Db } from '../platform/db';
import { SnapshotUnreadableError, buildSchema, nextPublishIsAmendment, normalizeTemplateSnapshot, pickRawSnapshot, sliceResults, unwrapResultsResponse } from './loader-schema';
import { MESSAGES } from './messages';
import { commercialPresets, resolvePcaNarrative, resolveRelianceText } from './pca-defaults';

export type EditorLoadFailure = 'invalid_id' | 'blocked' | 'unavailable' | 'not_downloaded' | 'unreadable';

/** Carries a sentence the inspector may read; the code is for tests and logs. */
export class EditorLoadError extends Error {
  constructor(
    readonly code: EditorLoadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'EditorLoadError';
  }
}

export interface EditorDataDeps {
  db: Db;
  account: Account;
  isBlocked: IsBlocked;
}

export type LoadEditorData = (inspectionId: string, scope?: string) => Promise<EditorData>;

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const asList = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function parse(body: CachedResource | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body.body) as unknown;
  } catch {
    return undefined;
  }
}

/** The envelope's `data` of one cached read, or undefined when it is absent or unreadable (what a failed read left the loader with). */
function dataOf(bodies: Map<string, CachedResource>, key: string): unknown {
  const parsed = parse(bodies.get(key));
  return isRec(parsed) ? parsed.data : undefined;
}

/** The cache key a read of the editor is stored under, with the inspection id filled in. */
function cacheKeys(inspectionId: string): { editor: Map<string, string>; all: string[] } {
  const editor = new Map<string, string>();
  for (const { editorRead, cacheKey } of EDITOR_READ_KEY_MAP) editor.set(editorRead.replace(':id', inspectionId), cacheKey.replace(':id', inspectionId));
  return { editor, all: [...new Set(editor.values())] };
}

async function assertOwnedPackage(deps: EditorDataDeps, inspectionId: string): Promise<void> {
  const rows = await deps.db.query<{ tenant_id: string | null; user_id: string | null }>('SELECT tenant_id, user_id FROM work_package WHERE inspection_id = ?', [inspectionId]);
  const row = rows[0];
  // Absent and foreign answer the same: nothing tells a caller whether another account holds this id.
  if (row === undefined || !sameAccount(deps.account, row.tenant_id, row.user_id)) throw new EditorLoadError('unavailable', MESSAGES.unavailable);
}

/**
 * Where a report stands as the server last said it, read from the cached inspection answer. `contentLocked` is the server's own
 * write lock (a published report takes no content edit until the inspector chooses "Edit and republish"), `editingAgain`
 * is the state after that choice, and `publishedVersionNumber` is the version clients read. All three describe the moment of
 * the last refresh: a report published since then is refused by the server when the device reconnects, and the editor closes
 * its live document when it learns of it.
 */
export interface ReportLock {
  contentLocked: boolean;
  editingAgain: boolean;
  publishedVersionNumber: number | null;
}

export const NO_REPORT_LOCK: ReportLock = { contentLocked: false, editingAgain: false, publishedVersionNumber: null };

/** The lock fields of the inspection detail answer's `data` (they sit beside `inspection`). Absent means not locked: an older server sends none. */
export function reportLockOf(data: unknown): ReportLock {
  if (!isRec(data)) return NO_REPORT_LOCK;
  const version = data.publishedVersionNumber;
  return {
    contentLocked: data.contentLocked === true,
    editingAgain: data.editingAgain === true,
    publishedVersionNumber: typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null,
  };
}

/** The lock of one cached inspection, for the screen that decides whether the editor opens for reading only. */
export async function loadReportLock(deps: Pick<EditorDataDeps, 'db' | 'account'>, inspectionId: string): Promise<ReportLock> {
  if (!isLocalId(inspectionId)) return NO_REPORT_LOCK;
  const key = cacheKeys(inspectionId).editor.get('/api/inspections/:id'.replace(':id', inspectionId)) ?? '';
  const bodies = await readCachedBodies(deps.db, accountKey(deps.account), [key]);
  return reportLockOf(dataOf(bodies, key));
}

/** What the server will do with the writes still queued, laid over the cached row so a reload does not show the old state. */
async function withQueuedWrites(deps: EditorDataDeps, inspectionId: string, row: Rec): Promise<Rec> {
  const queued = await listOutbox(deps.db, { account: deps.account, inspectionId, states: ['pending'] });
  let out = row;
  for (const entry of queued) {
    let payload: unknown;
    try {
      payload = JSON.parse(entry.payload);
    } catch {
      continue;
    }
    if (entry.op === 'inspection.update' && isRec(payload) && isRec(payload.changes)) out = { ...out, ...payload.changes };
    // The server refuses a cancelled inspection; showing it completed would promise what the replay cannot deliver.
    if (entry.op === 'inspection.complete' && out.status !== 'cancelled') out = { ...out, status: 'completed' };
  }
  return out;
}

const EMPTY_COMPLIANCE: Omit<CompliancePanelData, 'relianceText'> = {
  reportSignoffs: [],
  psq: null,
  documentReview: [],
  conformance: { standard: 'E2018-24', conforms: false },
};

/**
 * `FieldDataSource.load` over the work-package cache. The same inspection the web loader would build, from the rows
 * the refresher stored for THIS account. It refuses, in this order: a bad id, a blocked inspection, a package that is
 * not this account's, and a package whose required reads are not on the device. It never answers with an empty shell.
 */
export function createEditorLoader(deps: EditorDataDeps): LoadEditorData {
  return async (inspectionId, scope) => {
    if (!isLocalId(inspectionId)) throw new EditorLoadError('invalid_id', MESSAGES.unavailable);
    if (await deps.isBlocked(inspectionId)) throw new EditorLoadError('blocked', MESSAGES.blocked);
    await assertOwnedPackage(deps, inspectionId);

    const keys = cacheKeys(inspectionId);
    const bodies = await readCachedBodies(deps.db, accountKey(deps.account), [...new Set([...keys.all, ...GLOBAL_RESOURCE_PATHS])]);
    const key = (editorRead: string): string => keys.editor.get(editorRead.replace(':id', inspectionId)) ?? '';

    const inspectionBody = parse(bodies.get(key('/api/inspections/:id')));
    const resultsBody = parse(bodies.get(key('/api/inspections/:id/results?scope=_default')));
    const reportBody = parse(bodies.get(key('/api/inspections/:id/report-data')));
    const data = isRec(inspectionBody) && isRec(inspectionBody.data) ? inspectionBody.data : undefined;
    const cachedRow = data !== undefined && isRec(data.inspection) ? data.inspection : undefined;
    const reportData = isRec(reportBody) && isRec(reportBody.data) ? reportBody.data : undefined;
    if (data === undefined || cachedRow === undefined || cachedRow.id !== inspectionId || resultsBody === undefined || reportData === undefined) {
      throw new EditorLoadError('not_downloaded', MESSAGES.notDownloaded);
    }

    const optional = (editorRead: string): unknown => dataOf(bodies, key(editorRead));
    const session = dataOf(bodies, '/api/session/context');

    const row = await withQueuedWrites(deps, inspectionId, cachedRow);
    const rawSnapshot = pickRawSnapshot(cachedRow, data);
    const { templateSnapshot: _ownSnapshot, ...inspectionRow } = row;

    const unitsData = optional('/api/inspections/:id/units');
    const progressData = optional('/api/inspections/:id/unit-progress');
    const complianceData = optional('/api/inspections/:id/compliance');
    const details = optional('/api/inspections/:id/statutory-details');
    const coverage = optional('/api/inspections/:id/statutory-form/coverage');
    const narrative = row.pcaNarrative;
    const cooling = isRec(session) && isRec(session.outboundCoolingWindow) ? session.outboundCoolingWindow : null;

    let schema: EditorData['schema'];
    let templateSnapshot: EditorData['templateSnapshot'];
    try {
      schema = buildSchema(rawSnapshot, reportData.sections);
      templateSnapshot = normalizeTemplateSnapshot(rawSnapshot);
    } catch (error) {
      if (error instanceof SnapshotUnreadableError) throw new EditorLoadError('unreadable', MESSAGES.cacheUnreadable);
      throw error;
    }

    // The shapes below are the server's; the editor reads them defensively. The casts are the loader's own boundary.
    return {
      inspection: inspectionRow as EditorInspection,
      schema,
      results: sliceResults(unwrapResultsResponse(resultsBody), scope),
      ratingLevels: asList(reportData.ratingLevels),
      tagLibrary: asList(dataOf(bodies, '/api/tags')),
      defectCategories: asList(dataOf(bodies, '/api/admin/defect-categories')),
      units: asList(isRec(unitsData) ? unitsData.units : undefined),
      unitProgress: isRec(progressData) ? (progressData as unknown as UnitProgress) : { units: [], commonRated: 0, total: 0 },
      unitInspectionMode: row.unitInspectionMode === 'per_unit' ? 'per_unit' : 'tagged',
      templateSnapshot,
      // Nothing cached says which revision of a statutory form governs the inspection, and a second implementation of
      // that date comparison here would disagree with the server's at some boundary. Null is "no panel", as for
      // every ordinary inspection.
      revisionStatus: null,
      statutoryDetails: isRec(details) ? (details as unknown as EditorData['statutoryDetails']) : null,
      statutoryCoverage: isRec(coverage) ? (coverage as unknown as EditorData['statutoryCoverage']) : null,
      compliance: isRec(complianceData) ? (complianceData as unknown as Omit<CompliancePanelData, 'relianceText'>) : EMPTY_COMPLIANCE,
      pcaNarrative: resolvePcaNarrative(narrative),
      relianceText: resolveRelianceText(narrative),
      commercialPresets: commercialPresets(),
      nextPublishIsAmendment: nextPublishIsAmendment(row.reportStatus),
      // The one state where the server honours the notice choice on a publish: the report was reopened with "Edit and republish".
      reopenedForEditing: reportLockOf(data).editingAgain,
      outboundCoolingWindow: cooling as EditorData['outboundCoolingWindow'],
      resultId: isRec(resultsBody) && isRec(resultsBody.data) && typeof resultsBody.data.resultId === 'string' ? resultsBody.data.resultId : null,
    };
  };
}
