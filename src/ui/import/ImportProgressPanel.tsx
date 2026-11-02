import type { ImportProgress } from './use-import-package';
import { PROGRESS_HEADING, PROGRESS_NOTE, progressCounts, progressInspections } from './copy';

/**
 * Progress of an import that sends its parts one after another, counted in inspections (a fixed number the package names), not in
 * parts: the number of parts grows while it runs. There is nothing to press here: the import is not cancelled half-way.
 */
export function ImportProgressPanel({ progress }: { progress: ImportProgress }) {
  const percent = Math.round((progress.done / progress.total) * 100);
  return (
    <section aria-label={PROGRESS_HEADING} aria-busy="true" className="flex flex-col gap-3" data-testid="import-progress">
      <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{PROGRESS_HEADING}</h2>
      <p role="status" className="text-base text-ih-fg-1">
        {progressInspections(progress.done, progress.total)}
      </p>
      <div role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 w-full overflow-hidden rounded-full bg-ih-bg-muted">
        <div className="h-full bg-ih-primary motion-reduce:transition-none" style={{ width: `${String(Math.max(percent, 4))}%` }} />
      </div>
      <p className="text-sm text-ih-fg-2">{progressCounts(progress.imported, progress.heldBack)}</p>
      <p className="text-sm text-ih-fg-3">{PROGRESS_NOTE}</p>
    </section>
  );
}
