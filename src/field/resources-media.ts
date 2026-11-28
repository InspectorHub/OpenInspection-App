import type { FieldResources, MediaPoolListing, TemplateSearchResult, TemplateSummary } from '@inspectorhub/field-ui';
import { apiPath, templatePath } from './api-client';
import { bodyData, isRec } from './commands-shared';
import { asList, readBody, text, type GalleryPhoto, type ResourceDeps } from './resources-shared';

/**
 * The picture and template reads: the gallery of an inspection's photos and the template picker.
 * Nothing of these is in the work package, so offline they answer the contract's "could not read" shapes.
 */

const UNANSWERED: MediaPoolListing = { photos: [], answered: false };
const EMPTY_PAGE: TemplateSearchResult = { templates: [], hasMore: false, page: 1, totalPages: 1 };
const TEMPLATE_PAGE_SIZE = 25;

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
