// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrefs, DEFAULT_INSPECTION_PREFS } from '../../field/resources-library';
import { resourceWorld } from '../../field/test-support/resource-world';
import { reply } from '../../field/test-support/scripted-api';
import { AUTO_ADVANCE_ALWAYS, AUTO_ADVANCE_KEYBOARD, AUTO_ADVANCE_LEGEND, AUTO_ADVANCE_OFF, COMPANY_WIDE, InspectionSection, PREFS_PENDING_NOTE } from './InspectionSection';

afterEach(cleanup);

async function rig(options: Parameters<typeof resourceWorld>[0] = {}) {
  const w = await resourceWorld(options);
  const real = createPrefs(w.deps);
  const patch = vi.fn(real.patch);
  const prefs = { ...real, patch };
  return { w, real, prefs, patch };
}

const radio = (name: string) => screen.findByRole('radio', { name });

describe('the inspection section of Settings', () => {
  it('shows the persisted company value while offline, says it applies to the whole company, and asks nothing', async () => {
    const { w, real, prefs } = await rig({ answers: [reply(200, { autoAdvance: 'off' })] });
    await real.load();
    w.state.online = false;
    render(<InspectionSection prefs={prefs} />);
    expect(await radio(AUTO_ADVANCE_OFF)).toBeChecked();
    expect(screen.getByRole('radio', { name: AUTO_ADVANCE_KEYBOARD })).not.toBeChecked(); // control
    expect(screen.getByRole('radio', { name: AUTO_ADVANCE_ALWAYS })).not.toBeChecked();
    expect(screen.getByRole('group', { name: AUTO_ADVANCE_LEGEND })).toBeInTheDocument();
    expect(screen.getByText(COMPANY_WIDE)).toBeInTheDocument();
    expect(COMPANY_WIDE).toMatch(/company/);
    expect(screen.queryByText(PREFS_PENDING_NOTE)).not.toBeInTheDocument();
    expect(w.api.calls).toHaveLength(1);
  });

  it('with nothing ever read the server default (keyboard) is not invented: the built-in default is shown', async () => {
    const { prefs } = await rig({ online: false });
    render(<InspectionSection prefs={prefs} />);
    const shown = DEFAULT_INSPECTION_PREFS.autoAdvance === 'always' ? AUTO_ADVANCE_ALWAYS : DEFAULT_INSPECTION_PREFS.autoAdvance === 'keyboard' ? AUTO_ADVANCE_KEYBOARD : AUTO_ADVANCE_OFF;
    expect(await radio(shown)).toBeChecked();
  });

  it('choosing a value calls patch with only that field, and nothing else changes', async () => {
    const { prefs, patch, w } = await rig({ answers: [reply(200, {}), reply(200, { autoAdvance: 'always' })] });
    render(<InspectionSection prefs={prefs} />);
    await userEvent.click(await radio(AUTO_ADVANCE_ALWAYS));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith({ autoAdvance: 'always' });
    expect(w.api.calls.find((c) => c.method === 'PATCH')?.json).toEqual({ autoAdvance: 'always' });
    expect(await radio(AUTO_ADVANCE_ALWAYS)).toBeChecked();
    expect(screen.queryByText(PREFS_PENDING_NOTE)).not.toBeInTheDocument(); // saved online: no waiting note
  });

  it('offline: the choice applies at once, the waiting note appears, and it goes when the change is sent', async () => {
    const { w, prefs, real } = await rig({ online: false, answers: [reply(200, { autoAdvance: 'always' })] });
    render(<InspectionSection prefs={prefs} />);
    expect(screen.queryByText(PREFS_PENDING_NOTE)).not.toBeInTheDocument();
    await userEvent.click(await radio(AUTO_ADVANCE_ALWAYS));
    expect(await screen.findByText(PREFS_PENDING_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: AUTO_ADVANCE_ALWAYS })).toBeChecked();
    expect(PREFS_PENDING_NOTE).toContain('back online');
    w.state.online = true;
    await real.flush();
    await waitFor(() => expect(screen.queryByText(PREFS_PENDING_NOTE)).not.toBeInTheDocument());
    expect(screen.getByRole('radio', { name: AUTO_ADVANCE_ALWAYS })).toBeChecked();
  });

  it('a refusal puts the control back and says why (control: the accepted case above keeps the choice)', async () => {
    const { prefs } = await rig({ answers: [reply(200, {}), reply(403)] }); // the first answer is the read when the screen opens
    render(<InspectionSection prefs={prefs} />);
    const before = DEFAULT_INSPECTION_PREFS.autoAdvance === 'off' ? AUTO_ADVANCE_ALWAYS : AUTO_ADVANCE_OFF;
    await userEvent.click(await radio(before));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: before })).not.toBeChecked());
  });

  it('every choice is at least 44 px tall and named', async () => {
    const { prefs } = await rig({ online: false });
    render(<InspectionSection prefs={prefs} />);
    await radio(AUTO_ADVANCE_OFF);
    for (const r of screen.getAllByRole('radio')) {
      expect(r.closest('label')?.className).toContain('min-h-11');
      expect(r).toHaveAccessibleName();
    }
  });
});

describe('the inspection section inside Settings', () => {
  it('is on the screen when there is a signed-in stack, and absent when there is none (control: both headings are looked up the same way)', async () => {
    const { createSignedInWorld } = await import('../../app/test-support/world');
    const { open, stackWith } = await import('../test-support/settings-world');
    const world = await createSignedInWorld();
    await open(world, { stack: stackWith() });
    expect(screen.getByRole('heading', { level: 2, name: 'Inspection' })).toBeInTheDocument();
    cleanup();
    await open(world);
    expect(screen.queryByRole('heading', { level: 2, name: 'Inspection' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Sync' })).toBeInTheDocument();
  });
});
