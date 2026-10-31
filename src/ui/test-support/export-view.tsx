import { render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import * as Y from 'yjs';
import { loadIdentity } from '../../auth/server-config';
import { resultsDocName } from '../../collab/connector';
import type { Db } from '../../platform/db';
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

/** One exportable inspection for whoever is signed in on this database, so the export question (not the empty-device result) opens. */
export async function seedExportableForSignedIn(db: Db, id = 'insp-export'): Promise<void> {
  const identity = await loadIdentity(db);
  if (identity === null) throw new Error('no stored identity to seed an export for');
  await db.run('INSERT INTO work_package (inspection_id, report_id, refreshed_at, quarantine_source, server_confirmed, tenant_id, user_id, purging) VALUES (?, NULL, 1, NULL, 1, ?, ?, 0)', [id, identity.tenantId, identity.userId]);
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.getMap<unknown>('results').set('item-0', { rating: 1, note: 'note' });
  for (const update of updates) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [resultsDocName(id), update]);
}
