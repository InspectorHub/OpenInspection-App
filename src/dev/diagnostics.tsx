import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { appTimings } from '../app/timings';
import { Body, Button, Heading, INPUT_CLASSES, Screen } from '../ui/kit';
import { useActionLatch } from '../ui/latch';
import { CHECKS, EXTRAS, stopKillSession } from './checks';
import type { CheckDef, CheckResult, DiagContext, DiagDeps } from './checks/types';
import { logResult } from './log';
import { createRealDiagDeps } from './real-deps';

export const INSPECTION_ID_STORAGE_KEY = 'diag.inspectionId';

const STATUS_TEXT: Record<CheckResult['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  needs_sign_in: 'NEEDS SIGN-IN',
  needs_input: 'NEEDS INSPECTION ID',
};

function readStoredInspectionId(): string {
  try {
    return localStorage.getItem(INSPECTION_ID_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeInspectionId(value: string): void {
  try {
    localStorage.setItem(INSPECTION_ID_STORAGE_KEY, value);
  } catch {
    // Storage may be unavailable; the field simply starts empty next time.
  }
}

export interface DiagnosticsProps {
  services: AppServices;
  /** The signed-in server origin, or null on the setup screen. */
  origin: string | null;
  onClose(): void;
  /** The device adapters; tests pass fakes, the screen composes the real ones otherwise. */
  deps?: DiagDeps;
}

function Row({ result }: { result: CheckResult | undefined }) {
  return (
    <p className="font-ih-mono text-sm break-words text-ih-fg-2">
      <span className="font-bold text-ih-fg-1">{result ? STATUS_TEXT[result.status] : 'NOT RUN'}</span> {result?.detail ?? ''}
    </p>
  );
}

export function Diagnostics({ services, origin, onClose, deps }: DiagnosticsProps) {
  const resolved = useMemo(() => deps ?? createRealDiagDeps(), [deps]);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [inspectionId, setInspectionId] = useState(readStoredInspectionId);
  const latch = useActionLatch();
  const inspectionRef = useRef(inspectionId);
  inspectionRef.current = inspectionId;

  useEffect(() => {
    return () => {
      void stopKillSession();
    };
  }, []);

  function record(result: CheckResult): void {
    logResult(result);
    setResults((previous) => ({ ...previous, [result.id]: result }));
  }

  function context(): DiagContext {
    return { services, origin, inspectionId: inspectionRef.current.trim(), deps: resolved, emit: record };
  }

  async function run(def: CheckDef): Promise<void> {
    setRunning(def.id);
    try {
      record(await def.run(context()));
    } finally {
      setRunning(null);
    }
  }

  async function runAll(): Promise<void> {
    setRunning('all');
    try {
      for (const def of CHECKS) {
        setRunning(def.id);
        record(await def.run(context()));
      }
    } finally {
      setRunning(null);
    }
  }

  const busy = running !== null;
  const summary = [...CHECKS, ...EXTRAS]
    .map((def) => results[def.id])
    .filter((result): result is CheckResult => result !== undefined)
    .map((result) => `${result.id} ${STATUS_TEXT[result.status]} ${result.detail}`)
    .join('\n');

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ih-bg-card">
      <Screen>
        <Heading>Diagnostics (development only)</Heading>
        <Body>Runs the device checks through the real adapters. Results are also written to the console as lines starting with the diag marker.</Body>
        <div className="flex flex-col gap-2">
          <label htmlFor="diag-inspection-id" className="text-base font-semibold text-ih-fg-1">
            Inspection id
          </label>
          <input
            id="diag-inspection-id"
            className={INPUT_CLASSES}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={inspectionId}
            onChange={(event) => {
              setInspectionId(event.target.value);
              storeInspectionId(event.target.value.trim());
            }}
          />
        </div>
        <Button busy={running === 'all'} disabled={busy} onClick={() => void latch(runAll)}>
          Run all
        </Button>
        <ul className="flex flex-col gap-4">
          {CHECKS.map((def) => (
            <li key={def.id} data-testid={`check-${def.id}`} className="flex flex-col gap-2 rounded-ih-card border border-ih-border p-3">
              <h2 className="text-base font-semibold text-ih-fg-1">{def.title}</h2>
              <p className="text-sm text-ih-fg-3">{def.hint}</p>
              <Row result={results[def.id]} />
              <Button variant="secondary" busy={running === def.id} disabled={busy} aria-label={`Run ${def.id}`} onClick={() => void latch(() => run(def))}>
                Run
              </Button>
              {EXTRAS.filter((extra) => extra.parent === def.id).map((extra) => (
                <div key={extra.id} data-testid={`check-${extra.id}`} className="flex flex-col gap-2 border-t border-ih-border pt-2">
                  <p className="text-sm text-ih-fg-3">{extra.hint}</p>
                  <Row result={results[extra.id]} />
                  <Button variant="secondary" busy={running === extra.id} disabled={busy} onClick={() => void latch(() => run(extra))}>
                    {extra.label}
                  </Button>
                </div>
              ))}
            </li>
          ))}
        </ul>
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-ih-fg-1">Summary</h2>
          <pre data-testid="summary" className="overflow-x-auto font-ih-mono text-xs whitespace-pre-wrap text-ih-fg-2">
            {summary}
          </pre>
        </section>
        <section data-testid="timings" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-ih-fg-1">Timings</h2>
          {appTimings.summary().length === 0 ? (
            <p className="font-ih-mono text-xs text-ih-fg-3">Nothing measured yet.</p>
          ) : (
            appTimings.summary().map((entry) => (
              <p key={entry.code} className="font-ih-mono text-xs break-words text-ih-fg-2">
                {`${entry.code} first ${String(entry.first)} ms, latest ${entry.last.map((ms) => `${String(ms)} ms`).join(', ')}`}
              </p>
            ))
          )}
        </section>
        <Button variant="quiet" onClick={onClose}>
          Close diagnostics
        </Button>
      </Screen>
    </div>
  );
}
