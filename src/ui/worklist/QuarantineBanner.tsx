import { Button, Notice } from '../kit';

/**
 * The server cannot tell a deleted inspection from one reassigned to somebody else or one that never existed, so the
 * words keep the "or" and never say "deleted" alone. They say what is true on this device: the data is still here.
 */
export function QuarantineSummary({ count }: { count: number }) {
  if (count === 0) return null;
  return <Notice tone="watch">{count === 1 ? '1 inspection is no longer on your list. If anything on it was not sent, it is still on this device.' : `${String(count)} inspections are no longer on your list. If anything on them was not sent, it is still on this device.`}</Notice>;
}

export function RowQuarantineBanner() {
  return (
    <p className="rounded-ih-card bg-ih-watch-bg px-3 py-2 text-sm leading-relaxed text-ih-watch-fg">
      No longer assigned to you or removed from the server. If anything on this inspection was not sent, it is still on this device. It can no longer be edited or sent.
    </p>
  );
}

/** Offered wherever an export is: the file is not encrypted and its keeping is the company's responsibility. */
export function ExportBlock({ company, onExport }: { company: string | null; onExport(): void }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm leading-relaxed text-ih-fg-2">This file contains customer personal information and is not encrypted. Keeping and deleting it is the responsibility of {company ?? 'your company'}.</p>
      <Button variant="secondary" onClick={onExport}>
        Export unsent data
      </Button>
    </div>
  );
}
