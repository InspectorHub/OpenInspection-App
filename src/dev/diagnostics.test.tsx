// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKS } from './checks';
import { INSPECTION_ID_STORAGE_KEY, Diagnostics } from './diagnostics';
import { resetLog } from './log';
import { createDiagRig } from './test-support';

beforeEach(() => {
  resetLog();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Diagnostics screen', () => {
  it('lists every check, runs one on demand and shows PASS with the fixed detail', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={null} deps={rig.deps} onClose={vi.fn()} />);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(CHECKS.length);
    expect(within(screen.getByTestId('check-db-blob')).getByText('NOT RUN')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run db-blob' }));
    const card = screen.getByTestId('check-db-blob');
    expect(await within(card).findByText('PASS')).toBeInTheDocument();
    expect(card).toHaveTextContent('blobs=3');
    expect(screen.getByTestId('summary')).toHaveTextContent(/^db-blob PASS blobs=3/);
  });

  it('shows FAIL for a failing check and NEEDS SIGN-IN, not FAIL, for one that needs a session', async () => {
    const rig = await createDiagRig({ signedIn: false });
    rig.ports.imageLoads = false;
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={null} deps={rig.deps} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Run files' }));
    expect(await within(screen.getByTestId('check-files')).findByText('FAIL')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run uploader-photo' }));
    const card = screen.getByTestId('check-uploader-photo');
    expect(await within(card).findByText('NEEDS SIGN-IN')).toBeInTheDocument();
    expect(within(card).queryByText('FAIL')).toBeNull();
  });

  it('shows NEEDS INSPECTION ID when signed in without one, and remembers the id once typed', async () => {
    const rig = await createDiagRig({ inspectionId: '' });
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={rig.ctx.origin} deps={rig.deps} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Run collab-ticket' }));
    expect(await within(screen.getByTestId('check-collab-ticket')).findByText('NEEDS INSPECTION ID')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Inspection id'), 'insp-7');
    expect(localStorage.getItem(INSPECTION_ID_STORAGE_KEY)).toBe('insp-7');
  });

  it('prefills the inspection id from the development storage key', async () => {
    localStorage.setItem(INSPECTION_ID_STORAGE_KEY, 'insp-9');
    const rig = await createDiagRig();
    render(<Diagnostics services={rig.services} origin={rig.ctx.origin} deps={rig.deps} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Inspection id')).toHaveValue('insp-9');
  });

  it('Run all runs every check in order and writes one console line per result', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={null} deps={rig.deps} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Run all' }));
    // The yjs check waits for its compaction timer; fire it when it appears.
    await waitFor(() => {
      expect(rig.timers.delays()).toContain(1000);
    });
    rig.timers.fireWithDelay(1000);
    await waitFor(() => {
      expect(screen.getByTestId('summary').textContent?.split('\n')).toHaveLength(CHECKS.length);
    });

    const lines = info.mock.calls.map((call) => String(call[0]));
    expect(lines.map((line) => line.split(' ')[1])).toEqual(CHECKS.map((def) => def.id));
    for (const line of lines) expect(line).toMatch(/^\[diag\] [a-z-]+ (true|false) \S/);
    expect(lines.find((line) => line.startsWith('[diag] db-blob '))).toMatch(/^\[diag\] db-blob true blobs=3 /);
    expect(lines.find((line) => line.startsWith('[diag] uploader-photo '))).toBe('[diag] uploader-photo false needs sign-in');
    expect((globalThis as { __diagLog?: string[] }).__diagLog).toEqual(lines);
  });

  it('prints no address, token or ticket in what it renders or logs', async () => {
    localStorage.setItem(INSPECTION_ID_STORAGE_KEY, 'insp-1');
    const rig = await createDiagRig();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={rig.ctx.origin} deps={rig.deps} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Run uploader-photo' }));
    await within(screen.getByTestId('check-uploader-photo')).findByText('PASS');
    const everything = `${document.body.textContent ?? ''}\n${info.mock.calls.map((call) => String(call[0])).join('\n')}`;
    expect(everything).not.toContain(rig.world.server.origin);
    expect(everything).not.toMatch(/https?:\/\//);
    expect(everything).not.toMatch(/token=|Bearer/);
  });

  it('extra buttons sit under their check and run on their own', async () => {
    const rig = await createDiagRig();
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={rig.ctx.origin} deps={rig.deps} onClose={vi.fn()} />);
    const lock = screen.getByTestId('check-lock-clock');
    await user.click(within(lock).getByRole('button', { name: 'Simulate: read lock now' }));
    expect(await within(screen.getByTestId('check-lock-simulate')).findByText('PASS')).toBeInTheDocument();
    expect(within(screen.getByTestId('check-uploader-photo')).getByRole('button', { name: 'Start kill test' })).toBeInTheDocument();
    expect(within(screen.getByTestId('check-uploader-photo')).getByRole('button', { name: 'Resume diag uploads' })).toBeInTheDocument();
  });

  it('Close calls onClose', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Diagnostics services={rig.services} origin={null} deps={rig.deps} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close diagnostics' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
