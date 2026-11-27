import { unwrapResultsResponse } from './loader-schema';

/**
 * The server keys of the photos in a cached results body: every `photos` list anywhere in the findings map — at the
 * finding, or inside a defect under `tabs` / `customComments` — deduplicated. A body that is not a results response
 * names none, and neither does a photo entry without a key.
 *
 * This is the report's photos only. A photo uploaded but never attached to a finding (the media pool's loose photos)
 * is not in the results, so it is not counted here; the work list says how many of the report's photos are on the
 * device, not how many photos the inspection has in total.
 */
export function listPhotoKeys(body: unknown): string[] {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      if (name === 'photos' && Array.isArray(child)) {
        for (const entry of child) {
          if (typeof entry === 'object' && entry !== null) {
            const key = (entry as { key?: unknown }).key;
            if (typeof key === 'string' && key !== '') keys.add(key);
          }
        }
      } else {
        walk(child);
      }
    }
  };
  walk(unwrapResultsResponse(body));
  return [...keys];
}
