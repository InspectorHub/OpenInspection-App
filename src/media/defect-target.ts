import type { MediaRow } from './store';

/** Where a photo of a defect row belongs once it has uploaded: the item's finding key, and the defect inside that item. */
export interface DefectTarget {
  findingKey: string;
  itemId: string;
  /** The id of the defect row: `cannedId` for a canned defect, `id` for a custom one. */
  customId: string;
  defectKind: 'canned' | 'custom';
}

const MAX_FIELD_CHARS = 512;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS;
}

/**
 * The defect a photo `meta` names, or null when it names an item (or is not a photo meta at all). The one place that
 * decides what a defect photo is: the store hides such rows from the editor's own queue with it, and the reconciler
 * attaches the uploaded key with it.
 */
export function defectTargetOfMeta(meta: unknown): DefectTarget | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  if (record.targetType !== 'defect') return null;
  const { findingKey, itemId, customId, defectKind } = record;
  if (!isText(findingKey) || !isText(itemId) || !isText(customId)) return null;
  if (defectKind !== 'canned' && defectKind !== 'custom') return null;
  return { findingKey, itemId, customId, defectKind };
}

/** The defect a stored photo row belongs to; null for any other row (an item photo, a clip, a row with unreadable meta). */
export function defectTargetOf(row: Pick<MediaRow, 'kind' | 'meta'>): DefectTarget | null {
  if (row.kind !== 'photo') return null;
  try {
    return defectTargetOfMeta(JSON.parse(row.meta));
  } catch {
    return null;
  }
}
