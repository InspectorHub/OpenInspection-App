import type { FieldResources, MediaPoolListing, SettingsSheetData, TemplateSearchResult, TemplateSummary } from '@inspectorhub/field-ui';
import { apiPath, templatePath } from './api-client';
import { bodyData, isRec } from './commands-shared';
import { asList, readBody, text, type CoverPhotoOption, type GalleryPhoto, type ResourceDeps } from './resources-shared';

/**
 * The picture and template reads: the gallery of an inspection's photos, the settings sheet, and the template picker.
 * Nothing of these is in the work package, so offline they answer the contract's "could not read" shapes.
 */

const UNANSWERED: MediaPoolListing = { photos: [], answered: false };
const EMPTY_PAGE: TemplateSearchResult = { templates: [], hasMore: false, page: 1, totalPages: 1 };
const TEMPLATE_PAGE_SIZE = 25;
const SHEET_TEMPLATE_LIMIT = 100;

/**
 * The built-in report appearance profiles, id and name only. A mirror of the engine's list (`BUILTIN_PROFILES`): the
 * settings sheet only needs to offer them, and the engine validates the id it is sent.
 */
const REPORT_PROFILES = [
  { id: 'signature', name: 'Signature' },
  { id: 'meridian', name: 'Meridian' },
  { id: 'terra', name: 'Terra' },
] as const;

/**
 * The attached and loose photos of one inspection as one deduplicated list (the engine's `flattenMedia`). A photo's
 * address is the one `urls.photo` gives for its key, never the server's own photo url: that one needs a Bearer header,
 * which an image tag cannot send.
 */
function flattenMedia(deps: ResourceDeps, inspectionId: string, json: unknown): GalleryPhoto[] {
  const data = bodyData(json);
  const photos: GalleryPhoto[] = [];
  const seen = new Set<string>();
  for (const entry of asList(data?.attached)) {
    if (!isRec(entry) || typeof entry.key !== 'string' || entry.key === '' || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const photo: GalleryPhoto = { key: entry.key, url: deps.photoUrl(inspectionId, entry.key), label: text(entry.itemLabel) ?? '' };
    if (typeof entry.itemId === 'string') photo.itemId = entry.itemId;
    if (typeof entry.photoIndex === 'number') photo.photoIndex = entry.photoIndex;
    if (typeof entry.annotated === 'boolean') photo.annotated = entry.annotated;
    if (typeof entry.originalKey === 'string') photo.originalKey = entry.originalKey;
    if (typeof entry.defectId === 'string') photo.defectId = entry.defectId;
    photos.push(photo);
  }
  for (const entry of asList(data?.pool)) {
    if (!isRec(entry) || typeof entry.key !== 'string' || entry.key === '' || seen.has(entry.key)) continue;
    seen.add(entry.key);
    photos.push({ key: entry.key, url: deps.photoUrl(inspectionId, entry.key), label: 'Unattached' });
  }
  return photos;
}

export function createMediaPool(deps: ResourceDeps): NonNullable<FieldResources['mediaPool']> {
  return {
    list: async (inspectionId) => {
      try {
        if (!deps.isOnline() || (await deps.isBlocked(inspectionId))) return UNANSWERED;
        const body = await readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'media') });
        return body === null ? UNANSWERED : { photos: flattenMedia(deps, inspectionId, body.json), answered: true };
      } catch {
        return UNANSWERED;
      }
    },
  };
}

function templateSummaries(value: unknown): TemplateSummary[] {
  const out: TemplateSummary[] = [];
  for (const entry of asList(value)) {
    if (isRec(entry) && typeof entry.id === 'string' && entry.id !== '' && typeof entry.name === 'string' && entry.name !== '') out.push({ id: entry.id, name: entry.name });
  }
  return out;
}

export function createSettingsSheet(deps: ResourceDeps): NonNullable<FieldResources['settingsSheet']> {
  return {
    load: async (inspectionId): Promise<SettingsSheetData | null> => {
      try {
        if (!deps.isOnline() || (await deps.isBlocked(inspectionId))) return null;
        const [row, templates, media] = await Promise.all([
          readBody(deps.api, { method: 'GET', path: apiPath(inspectionId) }),
          readBody(deps.api, { method: 'GET', path: templatePath(), query: { page: '1', pageSize: String(SHEET_TEMPLATE_LIMIT) } }),
          readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'media') }),
        ]);
        // Without the inspection row the sheet would offer a form that saves blanks over the stored values.
        const data = row === null ? undefined : bodyData(row.json);
        if (data === undefined) return null;
        const inspection = isRec(data.inspection) ? data.inspection : data;
        const photos: CoverPhotoOption[] = media === null ? [] : flattenMedia(deps, inspectionId, media.json).map((p) => ({ key: p.key, url: p.url, label: p.label }));
        return {
          inspection,
          templates: templates === null || !isRec(templates.json) ? [] : templateSummaries(templates.json.data),
          photos,
          profiles: REPORT_PROFILES.map((p) => ({ id: p.id, name: p.name })),
        };
      } catch {
        return null;
      }
    },
  };
}

export function createTemplateSearch(deps: ResourceDeps): NonNullable<FieldResources['templateSearch']> {
  return {
    search: async ({ q, page }) => {
      if (!deps.isOnline()) return EMPTY_PAGE;
      const wanted = Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1));
      const query: Record<string, string> = { page: String(wanted), pageSize: String(TEMPLATE_PAGE_SIZE) };
      if (q !== '') query.q = q;
      const body = await readBody(deps.api, { method: 'GET', path: templatePath(), query });
      if (body === null || !isRec(body.json)) return EMPTY_PAGE;
      const meta = isRec(body.json.meta) ? body.json.meta : null;
      const metaPage = typeof meta?.page === 'number' ? meta.page : 1;
      const totalPages = typeof meta?.totalPages === 'number' ? meta.totalPages : 1;
      return { templates: templateSummaries(body.json.data), hasMore: meta !== null && metaPage < totalPages, page: metaPage, totalPages };
    },
  };
}
