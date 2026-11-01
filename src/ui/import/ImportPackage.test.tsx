// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { IMPORT_LIMIT_CEILINGS } from '@inspectorhub/offline-package';
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePackage } from '../../offline/test-support/import-fixtures';
import type { ApiOutcome } from '../../field/api-client';
import { choose, fileInput, ok, open, refused, runToResult, toConfirm, zipFile } from '../test-support/import-test-kit';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

describe('choosing a file', () => {
  it('the picker accepts zip files and nothing is sent when one is chosen', async () => {
    const { calls } = await open();
    expect(fileInput().accept).toBe('.zip,application/zip,application/x-zip-compressed');
    await choose(zipFile(makePackage({ inspections: 3, photos: { 0: 1 }, updates: { 1: 2 } }).zip));
    const preview = await screen.findByTestId('import-preview');
    const field = (label: string): string | null | undefined => within(preview).getByText(label).nextElementSibling?.textContent;
    expect(field('Inspections')).toBe('3');
    expect(field('Queued changes')).toBe('2');
    expect(field('Photos')).toBe('1');
    expect(field('Device')).toBe('device-1');
    expect(field('Exported by (user ID)')).toBe('user-1');
    expect(calls).toHaveLength(0);
  });

  it('paints "Reading the package" before the file is read and parsed, then shows the preview', async () => {
    const hold: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    await open(undefined, 'tenant-1', () => gate);
    const file = zipFile(makePackage({ inspections: 2 }).zip);
    const read = vi.spyOn(file, 'arrayBuffer');
    await choose(file);
    expect(screen.getByText('Reading the package...')).toBeVisible();
    expect(screen.queryByTestId('import-file-input')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('import-preview')).toBeNull();
    await act(async () => hold.release?.());
    await screen.findByTestId('import-preview');
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Reading the package...')).toBeNull();
  });

  it('choosing the very same file again after a refusal is read again (the input is a fresh one each time)', async () => {
    await open();
    const user = userEvent.setup();
    const notAPackage = zipFile(new TextEncoder().encode('not a zip at all'), 'same.zip');
    const read = vi.spyOn(notAPackage, 'arrayBuffer');
    await user.upload(fileInput(), notAPackage);
    await screen.findByRole('alert');
    expect(fileInput().value).toBe('');
    await user.upload(fileInput(), notAPackage);
    await screen.findByRole('alert');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('the visible button opens the system picker through the input', async () => {
    await open();
    const click = vi.spyOn(fileInput(), 'click');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Choose a package file' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a file over the size limit', () => Object.defineProperty(zipFile(new Uint8Array(8), 'big.zip'), 'size', { value: IMPORT_LIMIT_CEILINGS.compressedBytes + 1 }), /over the 24 MiB limit/],
    ['an empty file', () => zipFile(new Uint8Array(0), 'empty.zip'), /empty/],
    ['a file that is not a package', () => zipFile(new TextEncoder().encode('not a zip at all'), 'notes.txt'), /not a valid InspectorHub package/],
  ])('refuses %s with a message and stays on the choice, sending nothing', async (_name, make, message) => {
    const { calls } = await open();
    await choose(make());
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('control: a valid package leaves no alert behind', async () => {
    await open();
    await choose(zipFile(makePackage({ inspections: 1 }).zip));
    await screen.findByTestId('import-preview');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the oversize file is refused before it is read', async () => {
    await open();
    const big = zipFile(new Uint8Array(8));
    Object.defineProperty(big, 'size', { value: IMPORT_LIMIT_CEILINGS.compressedBytes + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    await choose(big);
    await screen.findByRole('alert');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a package for another company', () => {
  it('is stopped at the preview: the import button is off and nothing is sent', async () => {
    const { calls } = await open(undefined, 'some-other-company');
    await choose(zipFile(makePackage({ inspections: 2 }).zip));
    expect((await screen.findByRole('alert')).textContent).toMatch(/belongs to a different company/);
    const review = screen.getByRole('button', { name: 'Review and import' });
    expect(review).toBeDisabled();
    await userEvent.setup().click(review);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('control: the same package for this company can be confirmed', async () => {
    await open(undefined, 'tenant-1');
    await choose(zipFile(makePackage({ inspections: 2 }).zip));
    expect(await screen.findByRole('button', { name: 'Review and import' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('confirming', () => {
  it('asks first, says the file holds personal information, and sends nothing until confirmed; Cancel sends nothing either', async () => {
    const { calls } = await open();
    await choose(zipFile(makePackage({ inspections: 2, updates: { 0: 1 } }).zip));
    const dialog = await toConfirm();
    expect(within(dialog).getByText(/Inspections: 2, queued changes: 1, photos: 0/)).toBeVisible();
    expect(within(dialog).getByText(/contains client personal information and is not encrypted/)).toBeVisible();
    expect(calls).toHaveLength(0);
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('warns about a slow upload when the package is large, and not when it is small', async () => {
    const MIB = 1024 * 1024;
    const big = makePackage({ inspections: 1, yjsBytes: 9 * MIB });
    expect(big.summary.bytes).toBeGreaterThan(8 * MIB);
    await open();
    await choose(zipFile(big.zip));
    const dialog = await toConfirm();
    expect(within(dialog).getByText(/can be slow/)).toBeVisible();
    expect(within(dialog).getByText(/importing it again is safe/)).toBeVisible();
    cleanup();

    const small = makePackage({ inspections: 1, yjsBytes: 7 * MIB });
    expect(small.summary.bytes).toBeLessThan(8 * MIB);
    await open();
    await choose(zipFile(small.zip));
    const quiet = await toConfirm();
    expect(within(quiet).queryByText(/can be slow/)).toBeNull();
  });

  it('two confirm taps in one frame import once (and a later, separate import is not blocked by the latch)', async () => {
    const hold: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const view = await open(async (_n, bytes) => {
      await gate;
      return ok(bytes);
    });
    await choose(zipFile(makePackage({ inspections: 2 }).zip));
    const dialog = await toConfirm();
    const confirm = within(dialog).getByRole('button', { name: 'Import package' });
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await screen.findByTestId('import-progress');
    hold.release?.();
    await screen.findByTestId('import-result');
    expect(view.calls).toHaveLength(1);

    // Control: once the first import has finished, "Import this file again" is not held by the latch.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import another file' }));
    await choose(zipFile(makePackage({ inspections: 1 }).zip));
    const second = await toConfirm();
    await userEvent.setup().click(within(second).getByRole('button', { name: 'Import package' }));
    await screen.findByTestId('import-result');
    expect(view.calls).toHaveLength(2);
  });
});

describe('progress', () => {
  it('shows the inspections processed so far while parts go, and the result after', async () => {
    const releases: Array<() => void> = [];
    const view = await open((n, bytes) =>
      n === 1
        ? refused(422, 'PACKAGE_TOO_LARGE', { limits: { inspections: 1, outbox: 500, photos: 1500, compressedBytes: IMPORT_LIMIT_CEILINGS.compressedBytes } })
        : new Promise<ApiOutcome>((resolve) => releases.push(() => resolve(ok(bytes)))),
    );
    await choose(zipFile(makePackage({ inspections: 3 }).zip));
    const dialog = await toConfirm();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Import package' }));
    const panel = await screen.findByTestId('import-progress');
    expect(within(panel).getByText('0 of 3 inspections processed')).toBeVisible();
    expect(within(panel).getByText(/Closing the app is safe/)).toBeVisible();
    expect(within(panel).getByText(/importing it again is safe/)).toBeVisible();
    await waitFor(() => expect(releases).toHaveLength(1));
    await act(async () => releases[0]?.());
    await waitFor(() => expect(within(screen.getByTestId('import-progress')).getByText('1 of 3 inspections processed')).toBeVisible());
    expect(within(screen.getByTestId('import-progress')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.queryByRole('button', { name: /Settings|Back/ })).toBeNull();
    for (let i = 1; i < 3; i++) {
      await waitFor(() => expect(releases).toHaveLength(i + 1));
      await act(async () => releases[i]?.());
    }
    await screen.findByTestId('import-result');
    expect(view.calls.length).toBe(4);
  });
});

describe('leaving', () => {
  it('the back button goes back to Settings', async () => {
    const { onClose } = await open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Done on the result goes back, and Import another file starts over at the choice (and forgets the old file)', async () => {
    const view = await runToResult(makePackage({ inspections: 1 }), (_n, b) => ok(b));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import another file' }));
    expect(screen.getByRole('button', { name: 'Choose a package file' })).toBeVisible();
    expect(screen.queryByTestId('import-result')).toBeNull();
    expect(view.onClose).not.toHaveBeenCalled();
    await choose(zipFile(makePackage({ inspections: 1 }).zip));
    const dialog = await toConfirm();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Import package' }));
    await screen.findByTestId('import-result');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Done' }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it('the back button is not offered while the import runs', async () => {
    const hold: { release?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    await open(async (_n, b) => {
      await gate;
      return ok(b);
    });
    await choose(zipFile(makePackage({ inspections: 1 }).zip));
    const dialog = await toConfirm();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Import package' }));
    await screen.findByTestId('import-progress');
    expect(screen.queryByRole('button', { name: 'Back to settings' })).toBeNull();
    hold.release?.();
    await screen.findByTestId('import-result');
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBeVisible();
  });
});
