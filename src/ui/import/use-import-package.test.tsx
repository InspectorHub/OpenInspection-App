// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createExportWorld } from '../../export/test-support/world';
import type { ApiCall } from '../../field/api-client';
import { confirmedBody, makePackage } from '../../offline/test-support/import-fixtures';
import { useImportPackage } from './use-import-package';

async function hook(tenantId: string) {
  const world = await createExportWorld();
  const calls: ApiCall[] = [];
  const api = {
    send: (call: ApiCall) => {
      calls.push(call);
      return Promise.resolve({ kind: 'response' as const, status: 200, json: confirmedBody(call.bytes ?? new Uint8Array()) });
    },
  };
  const rendered = renderHook(() =>
    useImportPackage({
      api,
      tenantId,
      share: { files: world.files, sharer: world.sharer, platform: 'ios' },
      now: () => world.clock.now(),
      importDeps: { sleep: () => Promise.resolve(), nextFrame: () => Promise.resolve() },
    }),
  );
  return { rendered, calls, world };
}

const fileOf = (bytes: Uint8Array): File => new File([bytes.slice()], 'export.zip');

describe('the import hook', () => {
  it('never sends a package that belongs to another company, even if start is called directly', async () => {
    const { rendered, calls } = await hook('tenant-2');
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 2, tenantId: 'tenant-1' }).zip)));
    expect(rendered.result.current.state.kind).toBe('preview');
    await act(async () => rendered.result.current.start());
    expect(calls).toHaveLength(0);
    expect(rendered.result.current.state.kind).toBe('preview');
  });

  it('control: the same package for the signed-in company is sent', async () => {
    const { rendered, calls } = await hook('tenant-1');
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 2, tenantId: 'tenant-1' }).zip)));
    await act(async () => rendered.result.current.start());
    expect(calls).toHaveLength(1);
    expect(rendered.result.current.state.kind).toBe('done');
  });

  it('start before a file is chosen does nothing', async () => {
    const { rendered, calls } = await hook('tenant-1');
    await act(async () => rendered.result.current.start());
    expect(calls).toHaveLength(0);
    expect(rendered.result.current.state.kind).toBe('choose');
  });

  it('choosing a different file replaces the first one: only the second is ever imported', async () => {
    const { rendered, calls } = await hook('tenant-1');
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 3 }).zip)));
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 1 }).zip)));
    await act(async () => rendered.result.current.start());
    expect(calls).toHaveLength(1);
    expect(rendered.result.current.state).toMatchObject({ kind: 'done', outcome: { report: { imported: ['insp-0'] } } });
  });

  it('a refused file after a good one forgets the good one: nothing is left to import', async () => {
    const { rendered, calls } = await hook('tenant-1');
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 1 }).zip)));
    await act(async () => rendered.result.current.choose(fileOf(new TextEncoder().encode('nope'))));
    expect(rendered.result.current.state.kind).toBe('choose');
    await act(async () => rendered.result.current.start());
    expect(calls).toHaveLength(0);
  });

  it('savePart without a package in memory reports failure instead of throwing', async () => {
    const { rendered } = await hook('tenant-1');
    await expect(rendered.result.current.savePart(['insp-0'])).resolves.toBe('failed');
  });

  it('control: savePart for ids that are in the package hands exactly those to the share sheet', async () => {
    const { rendered, world } = await hook('tenant-1');
    await act(async () => rendered.result.current.choose(fileOf(makePackage({ inspections: 3 }).zip)));
    const spy = vi.spyOn(world.sharer, 'share');
    await expect(rendered.result.current.savePart(['insp-2'])).resolves.toBe('saved');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
