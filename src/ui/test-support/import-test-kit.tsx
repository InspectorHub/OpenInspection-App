// @vitest-environment jsdom
import { readPackageSummary } from '@inspectorhub/offline-package';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { createExportWorld, type ExportWorld } from '../../export/test-support/world';
import type { Api, ApiCall, ApiOutcome } from '../../field/api-client';
import { confirmedBody, errorBody } from '../../offline/test-support/import-fixtures';
import { ImportPackage } from '../import/ImportPackage';

export type Respond = (call: number, bytes: Uint8Array) => ApiOutcome | Promise<ApiOutcome>;
export const ok = (bytes: Uint8Array): ApiOutcome => ({ kind: 'response', status: 200, json: confirmedBody(bytes) });
export const refused = (status: number, code: string, details?: Record<string, unknown>): ApiOutcome => ({ kind: 'response', status, json: errorBody(code, details) });
export const idsOf = (bytes: Uint8Array): string[] => readPackageSummary(bytes).manifest.inspections.map((i) => i.id);

export function scripted(respond: Respond): { api: Pick<Api, 'send'>; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  return {
    calls,
    api: {
      send: async (call) => {
        calls.push(call);
        return respond(calls.length, call.bytes ?? new Uint8Array());
      },
    },
  };
}

export const zipFile = (bytes: Uint8Array, name = 'export.zip'): File => new File([bytes.slice()], name, { type: 'application/zip' });

export interface Opened {
  world: ExportWorld;
  onClose: ReturnType<typeof vi.fn>;
  calls: ApiCall[];
}

export async function open(respond: Respond = (_n, b) => ok(b), tenantId = 'tenant-1', frame?: () => Promise<void>): Promise<Opened> {
  const world = await createExportWorld();
  const rig = scripted(respond);
  const onClose = vi.fn();
  render(
    <ImportPackage
      api={rig.api}
      tenantId={tenantId}
      share={{ files: world.files, sharer: world.sharer, platform: 'ios' }}
      now={() => world.clock.now()}
      onClose={onClose}
      importDeps={{ sleep: () => Promise.resolve(), nextFrame: frame ?? (() => Promise.resolve()) }}
    />,
  );
  return { world, onClose, calls: rig.calls };
}

export const fileInput = (): HTMLInputElement => screen.getByTestId('import-file-input') as HTMLInputElement;

export async function choose(file: File): Promise<void> {
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  });
}

export async function toConfirm(): Promise<HTMLElement> {
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Review and import' }));
  return screen.findByRole('alertdialog');
}

export async function runToResult(made: { zip: Uint8Array }, respond: Respond): Promise<Opened> {
  const view = await open(respond);
  await choose(zipFile(made.zip));
  const dialog = await toConfirm();
  await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Import package' }));
  await screen.findByTestId('import-result');
  return view;
}

