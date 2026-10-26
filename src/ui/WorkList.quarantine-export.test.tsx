// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedPkg, seedTenantName, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

const rowOf = async (id: string): Promise<HTMLElement> => screen.findByTestId(`row-${id}`);

async function quarantined(): Promise<void> {
  await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
}

describe('WorkList: exporting from a quarantined row', () => {
  // Intended contract change: the legal paragraph used to repeat on every quarantined row. It is said once in the summary above the
  // list, and in full in the export question; the row keeps only the button.
  it('with an export handler a quarantined row has the export button beside Remove, and no paragraph of its own; the summary names the company once', async () => {
    await quarantined();
    await seedTenantName(w.db, 'Acme Inspections');
    const onExport = vi.fn();
    renderList(w.stack, { onExport });
    const row = await rowOf('q1');
    expect(row).not.toHaveTextContent('not encrypted');
    expect(row).not.toHaveTextContent('responsibility');
    expect(within(row).getByRole('button', { name: 'Export unsent data' }).parentElement).toBe(within(row).getByRole('button', { name: /^Remove .+ from this device$/ }).parentElement);
    const summary = screen.getByText(/Exported files contain customer information/);
    expect(summary).toHaveTextContent('Exported files contain customer information and are not encrypted; Acme Inspections is responsible for storing and deleting them.');
    expect(screen.getAllByText(/not encrypted/)).toHaveLength(1);
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Export unsent data' }));
    expect(onExport).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('without a company name the summary says your company', async () => {
    await quarantined();
    renderList(w.stack, { onExport: vi.fn() });
    await rowOf('q1');
    expect(screen.getByText(/Exported files contain customer information/)).toHaveTextContent('your company is responsible');
  });

  it('with no export handler the summary says nothing about exported files (control)', async () => {
    await quarantined();
    renderList(w.stack);
    await rowOf('q1');
    expect(screen.queryByText(/Exported files/)).toBeNull();
  });

  it('the two row actions stack on a narrow screen and sit side by side on a wide one', async () => {
    await quarantined();
    renderList(w.stack, { onExport: vi.fn() });
    const row = await rowOf('q1');
    const holder = within(row).getByRole('button', { name: 'Export unsent data' }).parentElement;
    expect(holder?.className).toContain('flex-col');
    expect(holder?.className).toContain('sm:flex-row');
  });
});
