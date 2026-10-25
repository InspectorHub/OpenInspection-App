import type { CommandResult, CommentsLibraryEntry, CommentsLibraryQuery, CommentsLibraryRow, CostItemView, CostItemWrite, CostItemsListing, FieldResources, InspectionPrefs, RepairItemOption } from '@inspectorhub/field-ui';
import { apiPath, apiRoute } from './api-client';
import { bodyData, isRec, isSuccess } from './commands-shared';
import { MESSAGES, blockedOf, failureOf, needsConnectionResult } from './messages';
import { asList, cachedData, readBody, text, writeFailure, type ResourceDeps } from './resources-shared';

/**
 * The tenant-level libraries: editor preferences, the canned-comment library, the repair-item catalogue, and the cost
 * lines of a commercial report. Every request is the one the web editor's resource route makes to the API.
 */

/** What the editor behaves like until the tenant's own preferences arrive (the web editor's defaults). */
export const DEFAULT_INSPECTION_PREFS: InspectionPrefs = {
  cloneDefault: 'rating_notes',
  autoAdvance: 'always',
  autoAdvanceDelayMs: 200,
  pinnedTagIds: [],
  requireDefectFields: 'none',
  agentRepairAccess: 'readwrite',
  reportLinkTtl: 'never',
};

const PREFS_ROUTE = '/api/tenant/inspection-prefs';
const COMMENTS_ROUTE = '/api/admin/comments';
const SEVERITIES: readonly string[] = ['good', 'marginal', 'significant', 'minor'];

export function createPrefs(deps: ResourceDeps): NonNullable<FieldResources['prefs']> {
  /** The last answer the server gave, so the editor keeps the tenant's choices while the connection is down. */
  let last: InspectionPrefs = DEFAULT_INSPECTION_PREFS;
  const merged = (json: unknown): InspectionPrefs | null => (isRec(json) ? { ...DEFAULT_INSPECTION_PREFS, ...(json as Partial<InspectionPrefs>) } : null);
  return {
    load: async () => {
      if (!deps.isOnline()) return last;
      const body = await readBody(deps.api, { method: 'GET', path: PREFS_ROUTE });
      const prefs = body === null ? null : merged(body.json);
      if (prefs !== null) last = prefs;
      return last;
    },
    patch: async (delta): Promise<CommandResult<InspectionPrefs>> => {
      if (!deps.isOnline()) return needsConnectionResult();
      const outcome = await deps.api.send({ method: 'PATCH', path: PREFS_ROUTE, json: delta });
      if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return writeFailure(outcome, MESSAGES.prefsNotSaved);
      const prefs = merged(outcome.json);
      if (prefs === null) return { ok: true };
      last = prefs;
      return { ok: true, data: prefs };
    },
  };
}

function commentRow(value: unknown): CommentsLibraryRow | null {
  if (!isRec(value) || typeof value.id !== 'string' || typeof value.text !== 'string') return null;
  const row: CommentsLibraryRow = {
    id: value.id,
    text: value.text,
    category: text(value.category) ?? null,
    severity: text(value.severity) ?? null,
    section: text(value.section) ?? null,
  };
  if (value.libraryId === null || typeof value.libraryId === 'string') row.libraryId = value.libraryId;
  if (typeof value.useCount === 'number') row.useCount = value.useCount;
  if (value.lastUsedAt === null || typeof value.lastUsedAt === 'string') row.lastUsedAt = value.lastUsedAt;
  return row;
}

/** The body the API takes for a save or an edit: an empty field is "none", a severity it does not know is none. */
function commentBody(entry: CommentsLibraryEntry): Record<string, unknown> | null {
  const body = entry.text.trim();
  if (body === '') return null;
  return {
    text: body,
    severity: SEVERITIES.includes(entry.severity) ? entry.severity : null,
    section: entry.section || null,
    category: entry.category || null,
    itemLabel: entry.itemLabel || null,
    repairSummary: entry.repairSummary || null,
    recommendedContractorTypeId: entry.recommendedContractorTypeId || null,
  };
}

export function createCommentsLibrary(deps: ResourceDeps): NonNullable<FieldResources['commentsLibrary']> {
  async function write(method: 'POST' | 'PUT', path: string, json?: unknown): Promise<CommandResult> {
    if (!deps.isOnline()) return needsConnectionResult();
    try {
      const outcome = await deps.api.send({ method, path, ...(json === undefined ? {} : { json }) });
      if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return writeFailure(outcome, MESSAGES.commentNotSaved);
      return { ok: true };
    } catch {
      return failureOf(MESSAGES.invalidValue);
    }
  }
  const save = (method: 'POST' | 'PUT', path: string, entry: CommentsLibraryEntry): Promise<CommandResult> => {
    const json = commentBody(entry);
    return json === null ? Promise.resolve(failureOf(MESSAGES.commentNotSaved)) : write(method, path, json);
  };
  return {
    list: async (query?: CommentsLibraryQuery) => {
      if (!deps.isOnline()) return [];
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(query ?? {})) if (typeof value === 'string' && value !== '') params[name] = value;
      const body = await readBody(deps.api, { method: 'GET', path: COMMENTS_ROUTE, ...(Object.keys(params).length === 0 ? {} : { query: params }) });
      const data = body === null || !isRec(body.json) ? [] : asList(body.json.data);
      return data.map(commentRow).filter((row): row is CommentsLibraryRow => row !== null);
    },
    touch: (id) => {
      try {
        return write('POST', apiRoute(COMMENTS_ROUTE, id, 'touch'));
      } catch {
        return Promise.resolve(failureOf(MESSAGES.invalidValue));
      }
    },
    save: (entry) => save('POST', COMMENTS_ROUTE, entry),
    edit: (id, entry) => {
      try {
        return save('PUT', apiRoute(COMMENTS_ROUTE, id), entry);
      } catch {
        return Promise.resolve(failureOf(MESSAGES.invalidValue));
      }
    },
  };
}

function repairOptions(recommendations: unknown, contractorTypes: unknown): RepairItemOption[] {
  const names = new Map<string, string>();
  for (const type of asList(contractorTypes)) if (isRec(type) && typeof type.id === 'string' && typeof type.name === 'string') names.set(type.id, type.name);
  const items: RepairItemOption[] = [];
  for (const rec of asList(recommendations)) {
    if (!isRec(rec) || typeof rec.id !== 'string' || typeof rec.name !== 'string') continue;
    const typeId = text(rec.recommendedContractorTypeId);
    items.push({
      id: rec.id,
      name: rec.name,
      category: text(rec.category) ?? null,
      defaultRepairSummary: text(rec.defaultRepairSummary) ?? '',
      contractorTypeName: typeId === undefined ? null : (names.get(typeId) ?? null),
    });
  }
  return items;
}

export function createRepairItems(deps: ResourceDeps): NonNullable<FieldResources['repairItems']> {
  return {
    list: async () => {
      if (deps.isOnline()) {
        const [recs, types] = await Promise.all([
          readBody(deps.api, { method: 'GET', path: '/api/recommendations' }),
          readBody(deps.api, { method: 'GET', path: '/api/contractor-types' }),
        ]);
        // The catalogue is useful without the contractor names, as on the web; without the catalogue itself it is the copy on the device.
        if (recs !== null) return repairOptions(dataOf(recs.json), types === null ? [] : dataOf(types.json));
      }
      return repairOptions(await cachedData(deps, '/api/recommendations'), await cachedData(deps, '/api/contractor-types'));
    },
  };
}

/** The `data` array of a success envelope, or the empty list. */
function dataOf(json: unknown): unknown {
  return isRec(json) ? json.data : undefined;
}

const EMPTY_COSTS: CostItemsListing = { items: [], reserveEnabled: false };

function costListing(json: unknown): CostItemsListing | null {
  if (!isRec(json) || !Array.isArray(json.data)) return null;
  return { items: json.data.filter(isRec) as unknown as CostItemView[], reserveEnabled: json.reserveEnabled === true };
}

/** The cost line the API takes: an unset number is null, an unset text is left out, as the web route builds it. */
function costBody(item: CostItemView): Record<string, unknown> {
  return {
    system: item.system,
    component: item.component,
    ...(item.location ? { location: item.location } : {}),
    action: item.action,
    costMethod: item.costMethod,
    quantity: item.quantity ?? null,
    uom: item.uom || null,
    unitCostCents: item.unitCostCents ?? null,
    lumpSumCents: item.lumpSumCents ?? null,
    eul: item.eul ?? null,
    effAge: item.effAge ?? null,
    rul: item.rul ?? null,
    suggestedRemedy: item.suggestedRemedy ?? '',
    bucket: item.bucket,
    sortOrder: item.sortOrder ?? 0,
  };
}

export function createCostItems(deps: ResourceDeps): NonNullable<FieldResources['costItems']> {
  async function listing(inspectionId: string): Promise<CostItemsListing> {
    if (deps.isOnline()) {
      const body = await readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'cost-items') });
      const fresh = body === null ? null : costListing(body.json);
      if (fresh !== null) return fresh;
    }
    const cached = await cachedData(deps, `/api/inspections/${inspectionId}/cost-items`);
    return Array.isArray(cached) ? { items: cached.filter(isRec) as unknown as CostItemView[], reserveEnabled: false } : EMPTY_COSTS;
  }

  async function write(inspectionId: string, change: CostItemWrite): Promise<CommandResult<{ id?: string }>> {
    const base = apiPath(inspectionId, 'cost-items');
    const outcome =
      change.intent === 'create'
        ? await deps.api.send({ method: 'POST', path: base, json: costBody(change.item) })
        : change.intent === 'update'
          ? await deps.api.send({ method: 'PATCH', path: apiPath(inspectionId, 'cost-items', change.item.id), json: costBody(change.item) })
          : await deps.api.send({ method: 'DELETE', path: apiPath(inspectionId, 'cost-items', change.itemId) });
    if (outcome.kind === 'problem' || !isSuccess(outcome.status)) return writeFailure(outcome, MESSAGES.requestFailed);
    // The cached lines are what the panel shows offline: bring them up to date, but never fail a write that landed.
    await deps.afterWrite?.(inspectionId).catch(() => false);
    const id = bodyData(outcome.json)?.id;
    return { ok: true, data: change.intent === 'create' && typeof id === 'string' ? { id } : {} };
  }

  return {
    list: async (inspectionId) => {
      try {
        return (await deps.isBlocked(inspectionId)) ? EMPTY_COSTS : await listing(inspectionId);
      } catch {
        return EMPTY_COSTS;
      }
    },
    save: async (inspectionId, change) => {
      try {
        if (await deps.isBlocked(inspectionId)) return blockedOf();
        if (!deps.isOnline()) return needsConnectionResult();
        return await write(inspectionId, change);
      } catch (error) {
        return failureOf(error instanceof RangeError ? MESSAGES.invalidValue : MESSAGES.requestFailed);
      }
    },
  };
}
