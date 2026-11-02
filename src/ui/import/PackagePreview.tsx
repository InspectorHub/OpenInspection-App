import type { PackageSummary } from '@inspectorhub/offline-package';
import { formatSize } from '../../offline/package-source';
import { FORMAT_LOCALE } from '../../platform/format-locale';
import { Button, Notice } from '../kit';
import { stripBidi } from '../worklist/format';
import { MATCH_BAD, MATCH_OK, OTHER_FILE_LABEL, PREVIEW_HEADING, PREVIEW_NOTE, REVIEW_LABEL } from './copy';

function exportedAtText(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return stripBidi(iso);
  try {
    return new Intl.DateTimeFormat(FORMAT_LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  } catch {
    return stripBidi(iso);
  }
}

export interface PackagePreviewProps {
  summary: PackageSummary;
  fileName: string;
  /** Whether the package was exported for the company this device is signed in to. */
  belongsHere: boolean;
  error: string | null;
  onChooseOther(): void;
  onReview(): void;
}

/**
 * What a chosen package holds, read from its manifest on this device. The manifest names no client and no address, only opaque ids
 * and counts. Whether it belongs to this company is decided against the signed-in account by the caller; the package's own claim is
 * only ever compared, never trusted as an identity. A mismatch switches the import off: the server would refuse it anyway, and
 * stopping here keeps the file from being sent.
 */
export function PackagePreview({ summary, fileName, belongsHere, error, onChooseOther, onReview }: PackagePreviewProps) {
  const { manifest, counts, bytes } = summary;
  const fields: Array<[string, string]> = [
    ['Exported', exportedAtText(manifest.exportedAt)],
    ['Exported by (user ID)', stripBidi(manifest.exportedBy)],
    ['Device', stripBidi(manifest.deviceId)],
    ['Inspections', String(counts.inspections)],
    ['Queued changes', String(counts.writes)],
    ['Photos', String(counts.photos)],
    ['File size', formatSize(bytes)],
  ];
  return (
    <section aria-label={PREVIEW_HEADING} className="flex flex-col gap-4" data-testid="import-preview">
      <div>
        <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{PREVIEW_HEADING}</h2>
        <p className="break-all text-sm text-ih-fg-3">{stripBidi(fileName)}</p>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {fields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-sm font-semibold text-ih-fg-3">{label}</dt>
            <dd className="break-words text-base text-ih-fg-1">{value}</dd>
          </div>
        ))}
      </dl>
      <Notice tone={belongsHere ? 'info' : 'bad'}>{belongsHere ? MATCH_OK : MATCH_BAD}</Notice>
      {error !== null && <Notice tone="bad">{error}</Notice>}
      <p className="text-sm text-ih-fg-3">{PREVIEW_NOTE}</p>
      <div className="flex flex-col gap-3">
        <Button variant="primary" disabled={!belongsHere} onClick={onReview}>
          {REVIEW_LABEL}
        </Button>
        <Button variant="secondary" onClick={onChooseOther}>
          {OTHER_FILE_LABEL}
        </Button>
      </div>
    </section>
  );
}
