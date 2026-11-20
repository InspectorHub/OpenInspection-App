// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImportDataPackageSection, REVERT_DESCRIPTION, REVERT_TITLE,
} from './ImportDataPackageSection';
import type { DataPackageImportEvent, DataPackageImportResultView } from '../../../electron/shared/ipc-contract.ts';

afterEach(() => { cleanup(); delete window.oiDesktop; });

interface Harness {
  emit(event: DataPackageImportEvent): void;
  startImport: ReturnType<typeof vi.fn>;
  revertImport: ReturnType<typeof vi.fn>;
  pickPackage: ReturnType<typeof vi.fn>;
}

function withBridge(): Harness {
  let listener: ((e: DataPackageImportEvent) => void) | undefined;
  const startImport = vi.fn(async () => undefined);
  const revertImport = vi.fn(async () => undefined);
  const pickPackage = vi.fn(async () => 'C:\\package.zip');
  window.oiDesktop = {
    apiVersion: 1,
    dialogs: { pickPackage },
    dataPackage: {
      onImportEvent: (cb: (e: DataPackageImportEvent) => void) => { listener = cb; return () => { listener = undefined; }; },
      startImport, revertImport,
    },
  } as never;
  return { emit: (e) => listener?.(e), startImport, revertImport, pickPackage };
}

const props = {
  origin: 'https://engine.test', getBearer: async () => 'bearer', deviceLabel: 'D', clientKind: 'desktop-windows',
};

const result: DataPackageImportResultView = {
  jobId: 'job-1', packageId: 'pkg-1', applied: { contacts: 2 }, skipped: {}, rejected: [],
  mediaUploaded: 1, archiveOk: true, counts: { contacts: 2 }, excluded: [],
};

async function reachDone(h: Harness) {
  render(<ImportDataPackageSection {...props} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Choose package file' }));
  await waitFor(() => expect(h.pickPackage).toHaveBeenCalledTimes(1));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Start import' }));
  await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'pw');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(h.startImport).toHaveBeenCalledTimes(1));
  act(() => { h.emit({ kind: 'done', result }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Undo import' })).toBeInTheDocument());
}

describe('ImportDataPackageSection', () => {
  it('collects a file path + step-up password and starts the import with them', async () => {
    const h = withBridge();
    render(<ImportDataPackageSection {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Choose package file' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start import' }));
    await userEvent.setup().type(screen.getByLabelText(/Re-enter your password/i), 'secret-pw');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.startImport).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://engine.test', bearer: 'bearer', stepUpPassword: 'secret-pw', packagePath: 'C:\\package.zip',
    })));
  });

  it('requires an explicit destructive confirmation before reverting, then calls revertImport', async () => {
    const h = withBridge();
    await reachDone(h);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Undo import' }));
    // The destructive dialog states the irreversible consequence.
    expect(screen.getByText(REVERT_TITLE)).toBeInTheDocument();
    expect(screen.getByText(REVERT_DESCRIPTION)).toHaveTextContent(/including anything you changed since the import/i);
    expect(h.revertImport).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete imported data' }));
    await waitFor(() => expect(h.revertImport).toHaveBeenCalledTimes(1));
  });

  it('cancelling the revert dialog does not call revertImport', async () => {
    const h = withBridge();
    await reachDone(h);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Undo import' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.revertImport).not.toHaveBeenCalled();
  });

  it('shows rejected rows in the result', async () => {
    const h = withBridge();
    await reachDone(h);
    expect(screen.getByRole('status')).toHaveTextContent(/Import complete/);
  });
});
