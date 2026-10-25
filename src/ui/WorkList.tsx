import { useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { realTimers, type TimerPort } from '../collab/timers';
import { setPinned } from '../offline/pins';
import type { Network } from '../platform/network';
import { DialogFocusFallback } from './ConfirmDialog';
import { Button, Notice } from './kit';
import { useActionLatch } from './latch';
import { LOAD_FAILED, PIN_REFUSED, REFRESH_THREW_TEXT, refreshSummaryText } from './worklist/copy';
import { FailedItemsPanel } from './worklist/FailedItemsPanel';
import { GROUP_ORDER, GROUP_TITLES, type GroupKey } from './worklist/format';
import { InspectionRow } from './worklist/InspectionRow';
import { useWorkListModel, type WorkListRow, type WorkListStack } from './worklist/model';
import { QuarantineSummary } from './worklist/QuarantineBanner';
import { ReconcileStatus } from './worklist/ReconcileStatus';
import { RemoveDialog } from './worklist/RemoveDialog';
import { RepairPanel } from './worklist/RepairPanel';
import { RowBoundary } from './worklist/RowBoundary';
import { StatusStrip } from './worklist/StatusStrip';
import { useOnline } from './worklist/useOnline';
import { usePullToRefresh } from './worklist/usePullToRefresh';
import { WorkListHeader } from './worklist/WorkListHeader';

export const DEFAULT_POLL_MS = 5000;

export interface WorkListProps {
  stack: WorkListStack;
  /** The editor opens here (Task 9). The default does nothing. A quarantined or removing row never calls it. */
  onOpenInspection?: (inspectionId: string) => void;
  /**
   * Offers an export on quarantined rows, with the responsibility wording. Without it no export is offered. `SignedIn` supplies it
   * and opens the export of that one inspection.
   */
  onExport?: (inspectionId: string) => void;
  /** Opens the export of everything on the device, from the header. Without it the header offers none. */
  onExportAll?: () => void;
  /** Link state. Without it the page's own online and offline events are used. */
  network?: Pick<Network, 'online' | 'onChange'>;
  now?: () => number;
  /** The device language, for the relative and calendar wording. Defaults to the page's. */
  locale?: string;
  /** How often the list is read again while the page is visible. 0 turns the interval off. */
  pollMs?: number;
  /** The timers that end a short-lived note. Defaults to the real ones. */
  timers?: TimerPort;
  /** Shown right under the page heading, so that notices with their own headings come after the first-level one. */
  notices?: ReactNode;
}

function Skeleton() {
  return (
    <div role="status" aria-label="Loading your work list" aria-busy="true" className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 rounded-ih-card bg-ih-bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function Group({ group, rows, children }: { group: GroupKey; rows: readonly WorkListRow[]; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="font-ih-display text-base font-bold text-ih-fg-2">
          {GROUP_TITLES[group]}
        </h2>
        <span className="text-sm text-ih-fg-3">{rows.length}</span>
      </div>
      <ul className="flex flex-col gap-3">{children}</ul>
    </section>
  );
}

/**
 * The home of a signed-in device: today's work, what is on the device, and what has not reached the server. Everything
 * shown is read from the database through the stack; the screen remembers only what it is in the middle of doing.
 */
export function WorkList({ stack, onOpenInspection, onExport, onExportAll, network, now = Date.now, locale, pollMs = DEFAULT_POLL_MS, timers = realTimers, notices }: WorkListProps) {
  const language = locale ?? (typeof navigator === 'undefined' ? undefined : navigator.language);
  const model = useWorkListModel(stack, { now, pollMs });
  const status = useSyncExternalStore(stack.status.subscribe, stack.status.get);
  const online = useOnline(network);
  const latch = useActionLatch();
  const [downloading, setDownloading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkListRow | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const repairRef = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<Element | null>(null);

  const snapshot = model.state.snapshot;

  async function download(): Promise<void> {
    setDownloading(true);
    setSummary(null);
    setNote(null);
    try {
      setSummary(refreshSummaryText(await stack.refresher.refresh({ reason: 'manual' })));
    } catch {
      setSummary(REFRESH_THREW_TEXT);
    } finally {
      setDownloading(false);
      await model.reload();
    }
  }

  // Pulling the page down is the same download as the button, through the same latch.
  usePullToRefresh(() => void latch(download), !downloading);

  async function togglePin(row: WorkListRow): Promise<void> {
    setNote(null);
    let done = false;
    try {
      done = await setPinned(stack.db, stack.account, row.id, !row.pinned);
    } catch {
      done = false;
    }
    if (!done) setNote(PIN_REFUSED);
    await model.reload();
  }

  function review(): void {
    const heading = repairRef.current;
    if (heading === null) return;
    if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
    heading.focus();
  }

  function closeRemove(): void {
    setRemoving(null);
    const opener = trigger.current;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    else headingRef.current?.focus();
  }

  const rows = snapshot?.rows ?? [];
  const quarantined = rows.filter((r) => r.blocked === 'quarantined').length;

  return (
    <DialogFocusFallback value={headingRef}>
      <div className="flex flex-col gap-4">
        <WorkListHeader
          updatedAt={snapshot?.updatedAt ?? null}
          now={now()}
          locale={language}
          online={online}
          downloading={downloading}
          summary={summary}
          onDownload={() => void latch(download)}
          onExport={onExportAll}
          headingRef={headingRef}
        />
        {notices}
        <StatusStrip status={status} />
        {snapshot !== null && (
          <ReconcileStatus
            outcome={snapshot.reconcile}
            now={now()}
            locale={language}
            onCheck={() => stack.reconciler.trigger('manual')}
            canRun={online !== false && snapshot.reconcile.status !== 'never'}
            timers={timers}
            onReview={snapshot.repair.rows.length > 0 ? review : null}
          />
        )}
        <QuarantineSummary count={quarantined} />
        {note !== null && <Notice tone="info">{note}</Notice>}
  
        {model.state.phase === 'loading' && <Skeleton />}
        {model.state.phase === 'error' && (
          <div className="flex flex-col gap-3">
            <Notice tone="bad">{LOAD_FAILED}</Notice>
            <Button variant="secondary" onClick={() => void model.retry()}>
              Try again
            </Button>
          </div>
        )}
        {snapshot !== null && rows.length === 0 && <p className="text-base leading-relaxed text-ih-fg-2">No inspections downloaded yet. Connect to the internet and tap Download today&apos;s work.</p>}
        {GROUP_ORDER.map((group) => {
          const inGroup = rows.filter((r) => r.group === group);
          if (inGroup.length === 0) return null;
          return (
            <Group key={group} group={group} rows={inGroup}>
              {inGroup.map((row) => (
                <RowBoundary key={row.id}>
                  <InspectionRow
                    row={row}
                    locale={language}
                    company={snapshot?.company ?? null}
                    onOpen={(r) => onOpenInspection?.(r.id)}
                    onTogglePin={(r) => void latch(() => togglePin(r))}
                    onRemove={(r) => {
                      trigger.current = document.activeElement;
                      setRemoving(r);
                    }}
                    onExport={onExport}
                  />
                </RowBoundary>
              ))}
            </Group>
          );
        })}
  
        {snapshot !== null && <FailedItemsPanel stack={stack} rows={rows} outbox={snapshot.failedOutbox} media={snapshot.failedMedia} now={now} reload={model.reload} notify={setNote} />}
        {snapshot !== null && (
          <RepairPanel
            stack={stack}
            rows={snapshot.repair.rows}
            foreign={snapshot.repair.foreign}
            orphanMedia={snapshot.repair.orphanMedia}
            foreignMedia={snapshot.repair.foreignMedia}
            reload={model.reload}
            headingRef={repairRef}
          />
        )}
  
        {removing !== null && (
          <RemoveDialog
            stack={stack}
            row={removing}
            now={now}
            reload={model.reload}
            onClose={closeRemove}
            onUnavailable={(message) => {
              setRemoving(null);
              setNote(message);
              headingRef.current?.focus();
            }}
            onRemoved={() => {
              setRemoving(null);
              setNote('Removed from this device.');
              headingRef.current?.focus();
              void model.reload();
            }}
          />
        )}
      </div>
    </DialogFocusFallback>
  );
}
