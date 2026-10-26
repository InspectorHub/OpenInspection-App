import { isLocalId } from './registry';

/**
 * What the work package downloads, and the checks every answer passes before it may be stored.
 *
 * The per-inspection set mirrors the reads the web editor's loader makes for one inspection
 * (`app/routes/inspection-edit/loader.server.ts` in the engine): the inspection row, its results (the whole map,
 * not the first-paint slice), the report data, and the reads that exist only for some jobs (units, unit progress,
 * compliance, statutory answers and coverage, cost lines), chosen from the inspection row by the same rules the
 * loader applies. The global set is what the loader reads once per session. Every one is a GET.
 */

/**
 * Which editor read each cached key answers. The cache is keyed by the path the package downloads; the editor's
 * loader does not always read that exact url, so a source that serves the editor from the cache must map the url it
 * is asked for to a key deliberately, never by string equality. `:id` stands for the inspection id.
 *
 *   cached key                                  the editor read it answers
 *   /api/inspections/:id                        the inspection row (loader)
 *   /api/inspections/:id/results                /api/inspections/:id/results?scope=_default (loader). The package caches the
 *                                               whole map without a query; the loader asks for the default scope only, and
 *                                               the whole map is a superset of it.
 *   /api/inspections/:id/report-data            same url (loader)
 *   /api/inspections/:id/units                  same url (loader, jobs that may have units)
 *   /api/inspections/:id/unit-progress          same url (loader, jobs that may have units)
 *   /api/inspections/:id/compliance             same url (loader, full PCA reports)
 *   /api/inspections/:id/statutory-details      same url (loader, templates that declare a statutory form)
 *   /api/inspections/:id/statutory-form/coverage  same url (loader, templates that declare a statutory form)
 *   /api/inspections/:id/cost-items             same url (the cost panel of commercial jobs; not a loader read)
 *   /api/session/context                        same url (loader)
 *   /api/tags                                   same url (loader)
 *   /api/admin/defect-categories                same url (loader)
 *   /api/recommendations                        same url (component-level read)
 *   /api/contractor-types                       same url (component-level read)
 *
 * `EDITOR_READ_KEY_MAP` below is the same table as data, and a test keeps it equal to what the package downloads.
 */
export interface EditorReadMapping {
  /** The url the editor asks for, `:id` for the inspection id; a query string is part of the pattern when the editor sends one. */
  editorRead: string;
  /** The key the package stores it under. */
  cacheKey: string;
}

export const EDITOR_READ_KEY_MAP: readonly EditorReadMapping[] = [
  { editorRead: '/api/inspections/:id', cacheKey: '/api/inspections/:id' },
  { editorRead: '/api/inspections/:id/results?scope=_default', cacheKey: '/api/inspections/:id/results' },
  { editorRead: '/api/inspections/:id/report-data', cacheKey: '/api/inspections/:id/report-data' },
  { editorRead: '/api/inspections/:id/units', cacheKey: '/api/inspections/:id/units' },
  { editorRead: '/api/inspections/:id/unit-progress', cacheKey: '/api/inspections/:id/unit-progress' },
  { editorRead: '/api/inspections/:id/compliance', cacheKey: '/api/inspections/:id/compliance' },
  { editorRead: '/api/inspections/:id/statutory-details', cacheKey: '/api/inspections/:id/statutory-details' },
  { editorRead: '/api/inspections/:id/statutory-form/coverage', cacheKey: '/api/inspections/:id/statutory-form/coverage' },
  { editorRead: '/api/inspections/:id/cost-items', cacheKey: '/api/inspections/:id/cost-items' },
  { editorRead: '/api/session/context', cacheKey: '/api/session/context' },
  { editorRead: '/api/tags', cacheKey: '/api/tags' },
  { editorRead: '/api/admin/defect-categories', cacheKey: '/api/admin/defect-categories' },
  { editorRead: '/api/recommendations', cacheKey: '/api/recommendations' },
  { editorRead: '/api/contractor-types', cacheKey: '/api/contractor-types' },
];

export const GLOBAL_RESOURCE_PATHS = ['/api/session/context', '/api/tags', '/api/recommendations', '/api/contractor-types', '/api/admin/defect-categories'] as const;

/** The path of an inspection's own row. The id is checked here, so no other module can build a url from an unchecked one. */
function inspectionRoot(id: string): string {
  if (!isLocalId(id)) throw new RangeError('invalid inspection id');
  return `/api/inspections/${id}`;
}

/** Always read, the inspection row first: the optional reads are chosen from it. */
export function baseInspectionPaths(id: string): string[] {
  const root = inspectionRoot(id);
  return [root, `${root}/results`, `${root}/report-data`];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function declaresStatutoryForm(inspection: Record<string, unknown>, data: Record<string, unknown>): boolean {
  const template = asRecord(data.template);
  const raw = inspection.templateSnapshot || data.templateSnapshot || template?.schema;
  try {
    const snapshot = asRecord(typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw);
    return Boolean(snapshot?.statutoryForm);
  } catch {
    return false;
  }
}

/**
 * The reads that exist only for some inspections, from the body of the inspection row. Same rules as the editor's
 * loader: units and progress for anything that is not a plain single-family job (or is per-unit), compliance for a
 * full PCA report, the statutory pair when the template declares a form. Cost lines are read for commercial jobs,
 * the only ones the cost panel is for. A body of the wrong shape asks for the cautious default (units), never throws.
 */
export function conditionalInspectionPaths(id: string, inspectionBody: unknown): string[] {
  const root = inspectionRoot(id);
  const data = asRecord(asRecord(inspectionBody)?.data) ?? {};
  const inspection = asRecord(data.inspection) ?? {};
  const paths: string[] = [];
  if (inspection.propertyType !== 'single_family' || inspection.unitInspectionMode === 'per_unit') paths.push(`${root}/units`, `${root}/unit-progress`);
  const commercial = inspection.propertyType === 'commercial';
  if (commercial && inspection.reportTier === 'full_pca') paths.push(`${root}/compliance`);
  if (declaresStatutoryForm(inspection, data)) paths.push(`${root}/statutory-details`, `${root}/statutory-form/coverage`);
  if (commercial) paths.push(`${root}/cost-items`);
  return paths;
}

export interface JsonLimits {
  maxDepth: number;
  /** Values (objects, arrays and scalars) in one response. */
  maxNodes: number;
  /** Elements in any one array. */
  maxArrayLength: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = { maxDepth: 64, maxNodes: 400_000, maxArrayLength: 50_000 };

/** Walks a parsed value with an explicit stack, so a hostile depth cannot overflow the call stack. */
export function jsonWithinLimits(value: unknown, limits: JsonLimits): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > limits.maxNodes || item.depth > limits.maxDepth) return false;
    const current = item.value;
    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayLength) return false;
      for (const child of current as unknown[]) stack.push({ value: child, depth: item.depth + 1 });
    } else if (typeof current === 'object' && current !== null) {
      for (const child of Object.values(current)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

/** `application/json` or a `+json` type. A captive portal or an error page answers something else. */
export function isJsonContentType(headers: Headers): boolean {
  const type = (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

export function hasSuccessEnvelope(json: unknown): json is { success: true; data: unknown } {
  return typeof json === 'object' && json !== null && !Array.isArray(json) && 'success' in json && json.success === true && 'data' in json;
}
