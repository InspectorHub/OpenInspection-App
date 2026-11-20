/**
 * Electron-only guided move flow. Owns step navigation and the derived
 * "what does not move" / "reconnect" checklists; the export and import panels
 * themselves are reused unchanged and keep their own step-up, progress,
 * excluded-acknowledgement and undo contracts. No bytes or secrets pass through
 * this component's state.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getDesktopBridge } from '../../desktop/bridge';
import type {
  DataPackageExportEvent, DataPackageImportEvent,
} from '../../../electron/shared/ipc-contract.ts';
import { ExportDataPackageSection } from '../settings/ExportDataPackageSection';
import { ImportDataPackageSection } from '../settings/ImportDataPackageSection';
import { ConfirmDialog } from '../ConfirmDialog';
import { BackLink, Button, Screen } from '../kit';
import {
  ARRIVE_STEPS, EXCLUDED_COPY, LEAVE_STEPS, RECONNECT_ITEMS,
  groupExcluded, type ExcludedItem, type MoveStep,
} from './move-steps';

export interface MoveWizardProps {
  readonly origin: string;
  readonly getBearer: () => Promise<string | null>;
  readonly deviceLabel: string;
  readonly clientKind: string;
  readonly mode: 'leave' | 'arrive';
  onBack(): void;
}

function StepRail({ steps, current }: { steps: readonly MoveStep[]; current: number }) {
  return (
    <ol className="flex flex-col gap-1 text-sm text-ih-fg-2" aria-label="Move steps">
      {steps.map((step, i) => (
        <li key={step.id} aria-current={i === current ? 'step' : undefined}
          className={i === current ? 'font-bold text-ih-fg-1' : i < current ? 'text-ih-fg-2' : 'text-ih-fg-3'}>
          {`${i + 1}. ${step.title}${step.optional ? ' (if available)' : ''}`}
        </li>
      ))}
    </ol>
  );
}

function Checklist({ excluded }: { excluded: readonly ExcludedItem[] }) {
  const groups = groupExcluded(excluded);
  return (
    <div className="flex flex-col gap-3">
      {groups.length > 0 && (
        <div>
          <p className="font-bold text-ih-fg-1">What did not move</p>
          <ul className="list-disc pl-5 text-sm text-ih-fg-2">
            {groups.map((g) => (
              <li key={g.cls}>{EXCLUDED_COPY[g.cls]} {`(${g.items.length})`}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="font-bold text-ih-fg-1">Reconnect on the new deployment</p>
        <ul className="list-disc pl-5 text-sm text-ih-fg-2">
          {RECONNECT_ITEMS.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** Capture the done event's excluded list from either panel so the checklist
 *  steps can show it, without either panel exposing its internal result. */
function useLastExcluded(mode: 'leave' | 'arrive'): {
  excluded: readonly ExcludedItem[];
  hasResult: boolean;
} {
  const [excluded, setExcluded] = useState<readonly ExcludedItem[]>([]);
  const [hasResult, setHasResult] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let offExport: (() => void) | undefined;
    let offImport: (() => void) | undefined;
    try {
      const bridge = getDesktopBridge();
      if (mode === 'leave') {
        offExport = bridge.dataPackage.onEvent((e: DataPackageExportEvent) => {
          if (!alive.current) return;
          if (e.kind === 'done') { setExcluded(e.result.excluded); setHasResult(true); }
        });
      } else {
        offImport = bridge.dataPackage.onImportEvent((e: DataPackageImportEvent) => {
          if (!alive.current) return;
          if (e.kind === 'done') { setExcluded(e.result.excluded); setHasResult(true); }
          // Undo deletes every imported row; the excluded list belonged to that
          // import and must not outlive it.
          if (e.kind === 'reverted') { setExcluded([]); setHasResult(false); }
        });
      }
    } catch { /* not in the desktop client */ }
    return () => { alive.current = false; offExport?.(); offImport?.(); };
  }, [mode]);
  return { excluded, hasResult };
}

export function MoveWizard(props: MoveWizardProps) {
  const steps = props.mode === 'leave' ? LEAVE_STEPS : ARRIVE_STEPS;
  const [current, setCurrent] = useState(0);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const { excluded, hasResult } = useLastExcluded(props.mode);
  const step = steps[current]!;

  const workForStep = (): ReactNode => {
    if (props.mode === 'leave' && step.id === 'export') {
      return <ExportDataPackageSection {...props} />;
    }
    if (props.mode === 'arrive' && step.id === 'import') {
      return <ImportDataPackageSection {...props} />;
    }
    if (step.id === 'links' || step.id === 'checklist') {
      return (
        <>
          {!hasResult && <p className="text-sm text-ih-fg-2">Finish the step above to see the list for this package.</p>}
          <Checklist excluded={excluded} />
        </>
      );
    }
    return <p className="text-sm text-ih-fg-2">{step.body}</p>;
  };

  const next = (): void => setCurrent((c) => Math.min(c + 1, steps.length - 1));
  const back = (): void => setCurrent((c) => Math.max(c - 1, 0));
  const atEnd = current === steps.length - 1;

  return (
    <Screen wide>
      <BackLink label="Back" onClick={props.onBack} />
      <h1 className="font-ih-display text-2xl font-bold text-ih-fg-1">
        {props.mode === 'leave' ? 'Move away from this workspace' : 'Move into this workspace'}
      </h1>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[auto_1fr]">
        <StepRail steps={steps} current={current} />
        <section aria-labelledby="move-step-heading" className="flex flex-col gap-3">
          <h2 id="move-step-heading" className="font-ih-display text-lg font-bold text-ih-fg-1">{step.title}</h2>
          {workForStep()}
          <div className="flex gap-2">
            {current > 0 && <Button variant="secondary" onClick={back}>Previous step</Button>}
            {!atEnd && <Button onClick={next}>Next step</Button>}
            {atEnd && <Button onClick={() => setConfirmLeave(true)}>Finish</Button>}
          </div>
        </section>
      </div>
      {confirmLeave && (
        <ConfirmDialog
          title="Leave this page?"
          description="The package stays on this computer. You can return to these steps any time."
          confirmLabel="Leave"
          busy={false}
          error={null}
          onConfirm={() => { setConfirmLeave(false); props.onBack(); }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}
    </Screen>
  );
}
