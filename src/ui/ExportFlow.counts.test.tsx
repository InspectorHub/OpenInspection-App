// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createExportWorld, sharedPackage } from '../export/test-support/world';
import { QUARANTINE_LABEL, ready, threeWithOneQuarantined, view } from './test-support/export-view';

afterEach(cleanup);

const LEFT_OUT = '2 inspections will be exported. 1 removed one is left out.';
const ALL_THREE = '3 inspections will be exported.';

describe('the counts line follows the quarantine checkbox', () => {
  it('says what the export will hold for the box as it is now: left out when unticked, taken when ticked, and back again', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    expect(dialog).toHaveTextContent(LEFT_OUT);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: QUARANTINE_LABEL }));
    expect(dialog).toHaveTextContent(ALL_THREE);
    expect(dialog).not.toHaveTextContent('left out');
    await user.click(screen.getByRole('checkbox', { name: QUARANTINE_LABEL }));
    expect(dialog).toHaveTextContent(LEFT_OUT);
  });

  it('the result reports what the question announced, for the unticked box', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    expect(dialog).toHaveTextContent(LEFT_OUT);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(screen.getByRole('dialog')).toHaveTextContent(/2 inspections, /);
    expect(sharedPackage(world).manifest.inspections).toHaveLength(2);
  });

  it('the result reports what the question announced, for the ticked box', async () => {
    const world = await createExportWorld();
    await threeWithOneQuarantined(world);
    view(world);
    const dialog = await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: QUARANTINE_LABEL }));
    expect(dialog).toHaveTextContent(ALL_THREE);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByRole('heading', { name: 'Export finished' });
    expect(screen.getByRole('dialog')).toHaveTextContent(/3 inspections, /);
    expect(sharedPackage(world).manifest.inspections).toHaveLength(3);
  });
});
