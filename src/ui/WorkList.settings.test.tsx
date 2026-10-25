// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { createListWorld, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;
beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

describe('the Settings button in the list header', () => {
  it('sits in the title row beside the connection chip, with a visible label, a decorative icon and a 44 px target', async () => {
    const onSettings = vi.fn();
    renderList(w.stack, { onSettings });
    const header = await screen.findByRole('banner');
    const button = within(header).getByRole('button', { name: 'Settings' });
    expect(button).toHaveTextContent('Settings');
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('min-w-11');
    expect(button.className).not.toContain('w-full');
    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    const row = button.closest('div.flex.flex-wrap');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('justify-between');
    expect(row?.contains(within(header).getByRole('heading', { level: 1 }))).toBe(true);
    await userEvent.setup().click(button);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('hands its element to the caller, so focus can come back to it', async () => {
    const ref = createRef<HTMLButtonElement>();
    renderList(w.stack, { onSettings: vi.fn(), settingsRef: ref });
    const button = await screen.findByRole('button', { name: 'Settings' });
    expect(ref.current).toBe(button);
  });

  it('is not there when nothing can open Settings (control)', async () => {
    renderList(w.stack);
    await screen.findByRole('button', { name: "Download today's work" });
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
});

describe('the title row at the narrowest width', () => {
  it('can wrap: the chip and the button never push the title off the screen', async () => {
    renderList(w.stack, { onSettings: vi.fn() });
    const heading = await screen.findByRole('heading', { level: 1 });
    const row = heading.closest('div.flex.flex-wrap');
    expect(row?.className).toContain('items-start');
    expect(row?.className).toContain('gap-3');
  });
});
