import { render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { seedInspection, type ExportWorld } from '../../export/test-support/world';
import { ExportFlow, type ExportFlowProps } from '../ExportFlow';

export const RESPONSIBILITY = (who: string): string => `This file contains customers' personal information and is not encrypted. ${who} is responsible for storing and deleting the file.`;
export const UNCONFIRMED = 'We could not confirm these inspections still exist, so the receiving office may refuse some of them.';
export const QUARANTINE_LABEL = 'Include inspections that were removed from my list (quarantined)';

export async function threeWithOneQuarantined(world: ExportWorld): Promise<void> {
  for (const id of ['insp-a', 'insp-b', 'insp-c']) await seedInspection(world, id, { quarantined: id === 'insp-b', writes: ['update'], photos: [{ pendingId: `photo-${id}` }] });
}

export function view(world: ExportWorld, props: Partial<ExportFlowProps> = {}) {
  const onClose = vi.fn();
  render(<ExportFlow services={{ db: world.db, files: world.files, clock: world.clock, platform: 'ios', sharer: world.sharer }} sharer={world.sharer} reconcile={() => Promise.resolve(true)} onClose={onClose} {...props} />);
  return { onClose };
}

export async function ready(): Promise<HTMLElement> {
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Export' })).toBeEnabled());
  return dialog;
}
