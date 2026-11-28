// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import { createStackWorld, type StackWorld } from '../app/test-support/stack-world';
import { saveRestoreBackup } from '../collab/restore-backup';
import { SqlitePersistence } from '../collab/y-sqlite';
import type { Db } from '../platform/db';
import { RestoreBackupNotice } from './RestoreBackupNotice';

afterEach(cleanup);

/** Starts the stack and waits until everything its start sequence runs has finished. */
async function run(stack: OfflineStack): Promise<void> {
  stack.start();
  await stack.settled();
  await stack.idle();
}

async function seed(w: StackWorld, inspectionId: string): Promise<void> {
  const restored = new Y.Doc();
  restored.getMap<unknown>('m').set('restored', true);
  await w.replay.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${inspectionId}`, Y.encodeStateAsUpdate(restored)]);
  const stale = new Y.Doc();
  stale.getMap<unknown>('m').set('stale', 1);
  await saveRestoreBackup(w.replay.db, `results-${inspectionId}`, Y.encodeStateAsUpdate(stale), 1_000);
}

async function backupRows(db: Db, docName: string): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM restore_backups WHERE doc_name = ?', [docName]);
  return Number(rows[0]?.n);
}

async function storedHas(db: Db, docName: string, key: string): Promise<unknown> {
  const doc = new Y.Doc();
  const persistence = new SqlitePersistence(db, docName, doc, {});
  try {
    await persistence.whenSynced;
    return doc.getMap<unknown>('m').get(key);
  } finally {
    await persistence.destroy().catch(() => undefined);
    doc.destroy();
  }
}

async function setup(): Promise<{ w: StackWorld; stack: OfflineStack }> {
  const w = await createStackWorld();
  await seed(w, 'insp-1');
  const stack = w.make();
  await run(stack);
  await waitFor(() => expect(stack.restoreNotices.get()).toHaveLength(1));
  return { w, stack };
}

describe('RestoreBackupNotice', () => {
  it('blocks with the plain-language notice and restores the copy on one tap', async () => {
    const user = userEvent.setup();
    const { w, stack } = await setup();
    render(<RestoreBackupNotice stack={stack} inspectionId="insp-1" />);

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: "Your offline copy couldn't be merged" })).toBeInTheDocument();
    expect(screen.getByText(/was set aside instead of being merged/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore my offline copy' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(0);
    expect(stack.restoreNotices.get()).toEqual([]);
    expect(await storedHas(w.replay.db, 'results-insp-1', 'stale')).toBe(1);
    expect(await storedHas(w.replay.db, 'results-insp-1', 'restored')).toBe(true);
    await stack.stop();
  });

  it('"Not now" only puts the dialog away: the banner stays and Review brings it back', async () => {
    const user = userEvent.setup();
    const { stack } = await setup();
    render(<RestoreBackupNotice stack={stack} inspectionId="insp-1" />);

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText(/is saved on this device/)).toBeInTheDocument();
    expect(await backupRows(stack.db, 'results-insp-1')).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    await stack.stop();
  });

  it('discarding deletes the saved copy, but only after its own confirm', async () => {
    const user = userEvent.setup();
    const { w, stack } = await setup();
    render(<RestoreBackupNotice stack={stack} inspectionId="insp-1" />);

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Discard saved copy' }));
    const confirm = await waitFor(() => screen.getByRole('alertdialog'));
    expect(within(confirm).getByRole('heading', { name: 'Discard the saved copy?' })).toBeInTheDocument();
    // The banner's discard button is still on screen behind the confirm: the row is still there until confirmed.
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(1);

    await user.click(within(confirm).getByRole('button', { name: 'Discard saved copy' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await backupRows(w.replay.db, 'results-insp-1')).toBe(0);
    expect(stack.restoreNotices.get()).toEqual([]);
    await stack.stop();
  });

  it('renders nothing when no copy was set aside for this inspection', async () => {
    const w = await createStackWorld();
    const stack = w.make();
    await run(stack);
    const { container } = render(<RestoreBackupNotice stack={stack} inspectionId="insp-1" />);
    expect(container).toBeEmptyDOMElement();
    await stack.stop();
  });
});
