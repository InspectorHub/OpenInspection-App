// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportDataPackageSection } from './ExportDataPackageSection';
import type { DataPackageExportEvent } from '../../../electron/shared/ipc-contract.ts';

afterEach(() => { cleanup(); delete window.oiDesktop; });

interface Harness {
  emit(event: DataPackageExportEvent): void;
  startExport: ReturnType<typeof vi.fn>;
}

function withBridge(over: Partial<Harness> = {}): Harness {
  let listener: ((e: DataPackageExportEvent) => void) | undefined;
  const startExport = vi.fn(async () => undefined);
  window.oiDesktop = {
    apiVersion: 1,
    dataPackage: {
      onEvent: (cb: (e: DataPackageExportEvent) => void) => { listener = cb; return () => { listener = undefined; }; },
      startExport,
      cancelExport: vi.fn(async () => undefined),
      pauseExport: vi.fn(async () => undefined),
      resumeExport: vi.fn(async () => undefined),
    },
  } as never;
  return { emit: (e) => listener?.(e), startExport, ...over };
}

const props = {
  origin: 'https://engine.test', getBearer: async () => 'bearer', deviceLabel: 'D', clientKind: 'desktop-windows',
};

describe('ExportDataPackageSection', () => {
  it('collects a step-up password and starts the export with it, clearing it from local state', async () => {
    const h = withBridge();
    render(<ExportDataPackageSection {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start export' }));
    await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'secret-pw');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.startExport).toHaveBeenCalledTimes(1));
    expect(h.startExport).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://engine.test', bearer: 'bearer', stepUpPassword: 'secret-pw',
    }));
    // On submit the panel leaves the prompting phase, so the password input is
    // unmounted entirely — the secret is not left in the DOM.
    await waitFor(() => expect(screen.queryByLabelText(/Re-enter your password/i)).toBeNull());
  });

  it('shows running progress, then the completed folder and sha256', async () => {
    const h = withBridge();
    render(<ExportDataPackageSection {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start export' }));
    await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'pw');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
    await new Promise((r) => setTimeout(r, 0)); // let the event subscription settle
    act(() => { h.emit({ kind: 'progress', progress: { stage: 'media', rows: 10, media: 3, bytes: 500, totalTables: 2, doneTables: 2 } }); });
    expect(screen.getByRole('status')).toHaveTextContent(/10 rows, 3 media processed/);
    act(() => { h.emit({ kind: 'done', result: {
      jobId: 'j', packageId: 'p', outputDir: 'D:\\exports\\j', rows: 10, media: 3, bytes: 500,
      manifestSha256: 'abc123', excluded: [{ class: 'external_media', table: 'inspection_media_pool', reason: 'x' }],
    } }); });
    expect(screen.getByText(/Export complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Manifest SHA-256: abc123/)).toBeInTheDocument();
    expect(screen.getByText(/1 excluded/)).toBeInTheDocument();
    // Completion is not acknowledged until the owner reviews excluded items.
    const doneBtn = screen.getByRole('button', { name: 'Done' });
    expect(doneBtn).toBeDisabled();
    // Muted while blocked: a disabled primary button at 60% opacity is hard to
    // tell from an enabled one, so the button flips to the secondary style.
    expect(doneBtn.className).toContain('border-ih-border');
    await userEvent.setup().click(screen.getByRole('checkbox', { name: /understand/i }));
    expect(doneBtn).toBeEnabled();
    expect(doneBtn.className).toContain('bg-ih-primary');
  });

  it('shows the preflight estimate and lets the owner pause/resume', async () => {
    const h = withBridge();
    render(<ExportDataPackageSection {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start export' }));
    await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'pw');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
    await new Promise((r) => setTimeout(r, 0));
    act(() => { h.emit({ kind: 'progress', progress: {
      stage: 'rows', rows: 0, media: 0, bytes: 0, totalTables: 3, doneTables: 0,
      estimate: { rows: 120000, bytes: 48 * 1024 * 1024, days: 2 },
    } }); });
    expect(screen.getByText(/Estimated: 120,000 rows/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pause export' }));
    act(() => { h.emit({ kind: 'progress', progress: {
      stage: 'rows', rows: 10, media: 0, bytes: 4000, totalTables: 3, doneTables: 0, paused: true,
    } }); });
    expect(screen.getByText(/Paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume export' })).toBeInTheDocument();
  });

  it('shows a closed error code from the main process', async () => {
    const h = withBridge();
    render(<ExportDataPackageSection {...props} />);
    await new Promise((r) => setTimeout(r, 0));
    act(() => { h.emit({ kind: 'error', code: 'step-up-failed' }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/step-up-failed/);
  });

  it('refuses to start when there is no bearer', async () => {
    withBridge();
    render(<ExportDataPackageSection {...props} getBearer={async () => null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start export' }));
    await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'pw');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/password and an active sign-in/i);
  });
});
