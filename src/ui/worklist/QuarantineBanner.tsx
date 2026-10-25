import { Button, Notice } from '../kit';

/**
 * The server cannot tell a deleted inspection from one reassigned to somebody else or one that never existed, so the
 * words keep the "or" and never say "deleted" alone. They say what is true on this device: the data is still here.
 */
export function QuarantineSummary({ count, company, exportOffered }: { count: number; company: string | null; exportOffered: boolean }) {
  if (count === 0) return null;
  return (
    <Notice tone="watch">
      <p>{count === 1 ? '1 inspection is no longer on your list. If anything on it was not sent, it is still on this device.' : `${String(count)} inspections are no longer on your list. If anything on them was not sent, it is still on this device.`}</p>
      {exportOffered && <p className="mt-2">{`Exported files contain customer information and are not encrypted; ${company ?? 'your company'} is responsible for storing and deleting them.`}</p>}
    </Notice>
  );
}

export function RowQuarantineBanner() {
  return (
    <p className="rounded-ih-card bg-ih-watch-bg px-3 py-2 text-sm leading-relaxed text-ih-watch-fg">
      No longer assigned to you or removed from the server. If anything on this inspection was not sent, it is still on this device. It can no longer be edited or sent.
    </p>
  );
}

/** The row's export button. The responsibility wording is said once, in the summary above the list, and in full in the export question. */
export function ExportButton({ onExport }: { onExport(): void }) {
  return (
    <Button variant="secondary" className="sm:flex-1" onClick={onExport}>
      Export unsent data
    </Button>
  );
}
