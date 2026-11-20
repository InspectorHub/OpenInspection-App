// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataPackageImportEvent } from '../../../electron/shared/ipc-contract.ts';
import { MoveDataPackageSection } from '../settings/MoveDataPackageSection';
import { MoveWizard } from './MoveWizard';
import {
  ARRIVE_STEPS, EXCLUDED_CLASSES, EXCLUDED_COPY, LEAVE_STEPS, RECONNECT_ITEMS,
  groupExcluded, isExcludedClass,
} from './move-steps';

afterEach(() => { cleanup(); delete (window as { oiDesktop?: unknown }).oiDesktop; });

const baseProps = {
  origin: 'https://engine.test',
  getBearer: async () => 'bearer',
  deviceLabel: 'desktop',
  clientKind: 'desktop-windows',
};

function withBridge() {
  // A real event emitter fans out to every subscriber. The wizard and the
  // embedded import panel both subscribe (the latter only while its step is
  // mounted), so keep them all and broadcast — keeping only the last would
  // deliver `reverted` to the wrong listener once the panel mounts.
  const importListeners = new Set<(e: DataPackageImportEvent) => void>();
  const onEvent = vi.fn(() => () => undefined);
  const onImportEvent = vi.fn((listener: (e: DataPackageImportEvent) => void) => {
    importListeners.add(listener);
    return () => { importListeners.delete(listener); };
  });
  (window as { oiDesktop?: unknown }).oiDesktop = {
    apiVersion: 1,
    dataPackage: { onEvent, onImportEvent },
  };
  return {
    onEvent, onImportEvent,
    emitImport: (e: DataPackageImportEvent) => { act(() => { for (const l of importListeners) l(e); }); },
  };
}

describe('move steps', () => {
  it('leaving and arriving are complete, ordered step sets', () => {
    expect(LEAVE_STEPS.map((s) => s.id)).toEqual(['understand', 'prepare', 'freeze', 'export', 'verify', 'links', 'finish']);
    expect(LEAVE_STEPS[2]!.optional).toBe(true); // freeze while J3 does not exist
    expect(ARRIVE_STEPS.map((s) => s.id)).toEqual(['choose', 'verify', 'import', 'checklist']);
  });

  it('every excluded class has plain copy', () => {
    for (const cls of EXCLUDED_CLASSES) expect(EXCLUDED_COPY[cls]).toBeTruthy();
    expect(RECONNECT_ITEMS.length).toBeGreaterThan(0);
  });

  it('groups only known classes and keeps the authoritative class name', () => {
    const grouped = groupExcluded([
      { class: 'withheld_secret', table: 't', reason: 'r' },
      { class: 'withheld_secret', table: 't2', reason: 'r' },
      { class: 'unknown_class', table: 't3', reason: 'r' },
    ]);
    expect(grouped.length).toBe(1);
    expect(grouped[0]!.cls).toBe('withheld_secret');
    expect(grouped[0]!.items).toHaveLength(2);
    expect(isExcludedClass('unknown_class')).toBe(false);
  });
});

describe('MoveWizard', () => {
  it('navigates steps and returns to settings on Back', async () => {
    withBridge();
    const onBack = vi.fn();
    render(<MoveWizard {...baseProps} mode="arrive" onBack={onBack} />);
    expect(screen.getByRole('heading', { name: 'Choose a package' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByRole('heading', { name: 'Check the package' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous step' }));
    expect(screen.getByRole('heading', { name: 'Choose a package' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('derives the what-did-not-move group from a real import result, and clears it on revert', async () => {
    const bridge = withBridge();
    render(<MoveWizard {...baseProps} mode="arrive" onBack={vi.fn()} />);
    const user = userEvent.setup();
    // An actual terminal event with an excluded class — the static reconnect
    // items alone must never be mistaken for a captured result.
    bridge.emitImport({
      kind: 'done',
      result: {
        jobId: 'j', packageId: 'p', applied: {}, skipped: {}, rejected: [],
        mediaUploaded: 0, archiveOk: true, counts: {},
        excluded: [
          { class: 'withheld_secret', table: 'credentials', reason: 'secret' },
          { class: 'withheld_secret', table: 'tokens', reason: 'secret' },
          { class: 'not_a_real_class', table: 'x', reason: 'ignored' },
        ],
      },
    });
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('Reconnect on the new deployment')).toBeInTheDocument();
    expect(screen.getByText('Accounting integrations')).toBeInTheDocument();
    // The grouped, authoritative class and its plain copy, with a count of 2.
    expect(screen.getByText(/Credentials and secrets were left out.*\(2\)/)).toBeInTheDocument();
    expect(screen.queryByText(/not_a_real_class/)).not.toBeInTheDocument();

    // Undo deletes every imported row: the excluded list must go with it.
    bridge.emitImport({ kind: 'reverted', done: true, processed: 2 });
    expect(screen.queryByText('What did not move')).not.toBeInTheDocument();
    expect(screen.getByText(/Finish the step above to see the list/)).toBeInTheDocument();
  });
});

describe('MoveDataPackageSection', () => {
  it('offers both directions', async () => {
    const onLeave = vi.fn();
    const onArrive = vi.fn();
    render(<MoveDataPackageSection onLeave={onLeave} onArrive={onArrive} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave this workspace' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Arrive at this workspace' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onArrive).toHaveBeenCalledTimes(1);
  });
});
