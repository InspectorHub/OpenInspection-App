import type { ResultMap, TemplateSchema, TemplateSnapshot } from '@inspectorhub/field-ui';

/**
 * The editor loader's pure logic, ported from the engine's `app/routes/inspection-edit/loader.server.ts`: the
 * report-data overlay on the template snapshot, the snapshot normalisation, the results envelope and slice, and the
 * amendment rule. Nothing here reads the network or the database; `editor-data.ts` feeds it cached bodies.
 */

type Rec = Record<string, unknown>;

/** The cached snapshot is not JSON. A fixed message: the text of the parser would tell the person nothing useful. */
export class SnapshotUnreadableError extends Error {
  constructor() {
    super('The cached template snapshot is not readable.');
    this.name = 'SnapshotUnreadableError';
  }
}

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The cached snapshot is parsed afresh for each use, so the overlay can never write into the one the editor keeps raw. */
function parseSnapshotValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new SnapshotUnreadableError();
    }
  }
  if (raw === undefined || raw === null) return raw;
  return JSON.parse(JSON.stringify(raw)) as unknown;
}

/**
 * The inspection's OWN `templateSnapshot` column first (inline structure edits are written there), then a top-level
 * one, then the source template's schema, which only legacy inspections without the column fall back to.
 */
export function pickRawSnapshot(inspection: Rec, data: Rec): unknown {
  const template = isRec(data.template) ? data.template : undefined;
  return inspection.templateSnapshot || data.templateSnapshot || template?.schema || undefined;
}

/**
 * The structure the editor edits. Never the overlaid `schema`, which must not be written back. A string is parsed, an
 * absent snapshot becomes the loader's default. A string that is not JSON throws: showing an empty template over an
 * unreadable one would invite the inspector to work on the wrong structure.
 */
export function normalizeTemplateSnapshot(raw: unknown): TemplateSnapshot {
  const parsed = parseSnapshotValue(raw === '' ? undefined : raw);
  return (parsed ?? { schemaVersion: 2, sections: [] }) as TemplateSnapshot;
}

/**
 * Overlays the report-data sections (which carry resolved rating levels and section data) onto the snapshot, and
 * restores what that projection leaves out on purpose: item `attributes` and `description`. A value the projection
 * does carry wins. Without sections from report-data the snapshot is used as it is.
 */
export function buildSchema(rawSnapshot: unknown, reportSections: unknown): TemplateSchema {
  const parsed = parseSnapshotValue(rawSnapshot === '' ? undefined : rawSnapshot);
  const schema: Rec = isRec(parsed) ? parsed : { sections: [] };

  const attributesById = new Map<string, unknown[]>();
  const descriptionById = new Map<string, string>();
  const ownSections = Array.isArray(schema.sections) ? (schema.sections as unknown[]) : [];
  for (const section of ownSections) {
    const items = isRec(section) && Array.isArray(section.items) ? (section.items as unknown[]) : [];
    for (const item of items) {
      if (!isRec(item) || typeof item.id !== 'string') continue;
      if (Array.isArray(item.attributes) && item.attributes.length > 0) attributesById.set(item.id, item.attributes as unknown[]);
      if (typeof item.description === 'string' && item.description !== '') descriptionById.set(item.id, item.description);
    }
  }

  if (Array.isArray(reportSections) && reportSections.length > 0) {
    schema.sections = reportSections.map((section) => {
      const s: Rec = isRec(section) ? { ...section } : {};
      if (!s.title && s.name) s.title = s.name;
      if (Array.isArray(s.items)) {
        s.items = (s.items as unknown[]).map((item) => {
          const it: Rec = isRec(item) ? { ...item } : {};
          if (!it.label && it.name) it.label = it.name;
          if (it.attributes === undefined && typeof it.id === 'string') {
            const attributes = attributesById.get(it.id);
            if (attributes) it.attributes = attributes;
          }
          if (it.description === undefined && typeof it.id === 'string') {
            const description = descriptionById.get(it.id);
            if (description) it.description = description;
          }
          return it;
        });
      }
      return s;
    });
  }
  // The snapshot's shape is the server's; the editor reads it defensively. One cast, at the boundary.
  return schema as unknown as TemplateSchema;
}

/** A report that is already published gets a new version on its next publish, which is therefore a revision. */
export function nextPublishIsAmendment(reportStatus: unknown): boolean {
  return reportStatus === 'published';
}

/** The results map out of the three shapes the endpoint has had: `data.results`, `data.data`, or the map itself under `data`. */
export function unwrapResultsResponse(body: unknown): ResultMap {
  if (!isRec(body)) return {};
  const data = body.data;
  if (!isRec(data)) return {};
  if (data.results && typeof data.results === 'object') return data.results as ResultMap;
  if (data.data && typeof data.data === 'object') return data.data as ResultMap;
  return data as ResultMap;
}

/**
 * The slice the server answers for `?scope=`: the keys that start with `<scope>:`. No scope is the common scope
 * (`_default`), which is what the loader asks for on first paint; meta keys such as `_inspector_signature` and every
 * unit's findings stay out of it.
 */
export function sliceResults(results: ResultMap, scope?: string): ResultMap {
  const prefix = `${scope === undefined || scope === '' ? '_default' : scope}:`;
  const out: ResultMap = {};
  for (const [key, value] of Object.entries(results)) {
    if (key.startsWith(prefix)) out[key] = value;
  }
  return out;
}
