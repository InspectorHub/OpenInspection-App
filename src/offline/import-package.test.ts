import { IMPORT_LIMIT_CEILINGS, readPackageSummary, type ImportReport } from '@inspectorhub/offline-package';
import { describe, expect, it, vi } from 'vitest';
import type { Api, ApiCall, ApiOutcome } from '../field/api-client';
import { createImportSend, defaultSendTimeoutMs, importPackage, IMPORT_PATH, tenantMatches, type ImportDeps } from './import-package';
import { confirmedBody, errorBody, makePackage } from './test-support/import-fixtures';

type Respond = (call: number, ids: string[], bytes: Uint8Array) => ApiOutcome | Promise<ApiOutcome>;

const ok = (body: unknown): ApiOutcome => ({ kind: 'response', status: 200, json: body });
const refused = (status: number, code: string, details?: Record<string, unknown>): ApiOutcome => ({ kind: 'response', status, json: errorBody(code, details) });
const problem = (p: Extract<ApiOutcome, { kind: 'problem' }>['problem']): ApiOutcome => ({ kind: 'problem', problem: p });
const idsOf = (bytes: Uint8Array): string[] => readPackageSummary(bytes).manifest.inspections.map((i) => i.id);

/** An Api that records each call and how many were in flight at once. Every call yields to the event loop so overlap is possible. */
function scripted(respond: Respond) {
  const calls: ApiCall[] = [];
  let inFlight = 0;
  let peak = 0;
  const api: Pick<Api, 'send'> = {
    send: async (call) => {
      calls.push(call);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const bytes = call.bytes ?? new Uint8Array();
        return await respond(calls.length, idsOf(bytes), bytes);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { api, calls, peak: () => peak };
}

function deps(api: Pick<Api, 'send'>, over: Partial<ImportDeps> = {}): ImportDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return { api, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), nextFrame: () => Promise.resolve(), sleeps, ...over } as ImportDeps & { sleeps: number[] };
}

const confirm: Respond = (_n, _ids, bytes) => ok(confirmedBody(bytes));
const LIMITS = { inspections: 1, outbox: 500, photos: 1500, compressedBytes: IMPORT_LIMIT_CEILINGS.compressedBytes };

/** Every input inspection ends in exactly one of imported or heldBack. */
function expectPartition(report: ImportReport, input: string[]): void {
  const held = report.heldBack.map((h) => h.id);
  expect([...report.imported, ...held].sort()).toEqual([...input].sort());
  expect(new Set([...report.imported, ...held]).size).toBe(input.length);
}

describe('the Send: what the transport hands the shared import', () => {
  it('a refusal is a RESULT with the server code and details, not an exception', async () => {
    const rig = scripted(() => refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }));
    const { send } = createImportSend(rig.api);
    const result = await send(makePackage({ inspections: 2 }).zip);
    expect(result).toMatchObject({ status: 404, code: 'NOT_FOUND', details: { inspectionId: 'insp-1' } });
  });

  it.each(['offline', 'unknown'] as const)('control: a problem "%s" (no answer arrived) rejects, so the shared import sends the part again', async (p) => {
    const rig = scripted(() => problem(p));
    const { send } = createImportSend(rig.api);
    await expect(send(makePackage({ inspections: 1 }).zip)).rejects.toThrow();
  });

  it('posts the package bytes unchanged to the import route as a zip and asks for the text of a non-JSON answer', async () => {
    const rig = scripted(confirm);
    const made = makePackage({ inspections: 2 });
    await createImportSend(rig.api).send(made.zip);
    const call = rig.calls[0];
    expect(call).toMatchObject({ method: 'POST', path: IMPORT_PATH, contentType: 'application/zip', keepText: true });
    expect(call?.bytes).toBe(made.zip);
    expect(call?.json).toBeUndefined();
    expect(call?.idempotencyKey).toBeUndefined();
  });

  it('the timeout grows with the size: a floor of a minute, 100 KiB/s, capped at ten minutes', () => {
    expect(defaultSendTimeoutMs(0)).toBe(60_000);
    expect(defaultSendTimeoutMs(1024 * 1024)).toBeGreaterThan(60_000);
    expect(defaultSendTimeoutMs(IMPORT_LIMIT_CEILINGS.compressedBytes)).toBeLessThanOrEqual(600_000);
    expect(defaultSendTimeoutMs(10 ** 12)).toBe(600_000);
    const small = makePackage({ inspections: 1 }).zip;
    const rig = scripted(confirm);
    void createImportSend(rig.api).send(small);
    return vi.waitFor(() => expect(rig.calls[0]?.timeoutMs).toBe(defaultSendTimeoutMs(small.byteLength)));
  });

  it('a body over the ceiling is answered 413 locally and never uploaded', async () => {
    const rig = scripted(confirm);
    const result = await createImportSend(rig.api).send(new Uint8Array(IMPORT_LIMIT_CEILINGS.compressedBytes + 1));
    expect(result).toMatchObject({ status: 413, code: 'PACKAGE_TOO_LARGE' });
    expect(rig.calls).toHaveLength(0);
  });

  it('a gateway page (not JSON) keeps a bounded piece of its text and is never read as a confirmation', async () => {
    const page = `<html>${'x'.repeat(5000)}</html>`;
    const rig = scripted(() => ({ kind: 'response', status: 200, json: undefined, text: page }));
    const made = makePackage({ inspections: 2 });
    const { send } = createImportSend(rig.api);
    const result = await send(made.zip);
    expect(result.status).toBe(200);
    expect(typeof result.body === 'string' && result.body.length).toBe(2000);

    const outcome = await importPackage(made.zip, deps(rig.api));
    expect(outcome.report.imported).toEqual([]);
    expect(outcome.report.heldBack.map((h) => h.id)).toEqual(made.ids);
    expect(outcome.report.requests).toBeGreaterThan(1);
  });

  it('control: a real 200 with the full body imports everything', async () => {
    const rig = scripted(confirm);
    const made = makePackage({ inspections: 2 });
    const outcome = await importPackage(made.zip, deps(rig.api));
    expect(outcome.report.imported).toEqual(made.ids);
    expect(outcome.report.heldBack).toEqual([]);
  });
});

describe('importing: the shared import over the transport', () => {
  it('a package that fits goes in one request, and is not split', async () => {
    const rig = scripted(confirm);
    const made = makePackage({ inspections: 3, photos: { 0: 1 }, updates: { 1: 1 } });
    const { report, stopped } = await importPackage(made.zip, deps(rig.api));
    expect(report.requests).toBe(1);
    expect(rig.calls).toHaveLength(1);
    expect(report.imported).toEqual(made.ids);
    expect(report.applied).toBe(1);
    expect(stopped).toBeNull();
  });

  it('a 422 PACKAGE_TOO_LARGE splits the package, and never more than one request is in flight', async () => {
    const rig = scripted((n, ids, bytes) => (n === 1 ? refused(422, 'PACKAGE_TOO_LARGE', { limits: LIMITS }) : ids.length > 0 ? ok(confirmedBody(bytes)) : problem('offline')));
    const made = makePackage({ inspections: 3 });
    const { report } = await importPackage(made.zip, deps(rig.api));
    expect(report.imported).toEqual(made.ids);
    expect(rig.calls.length).toBeGreaterThan(1);
    expect(rig.peak()).toBe(1);
    // Every part sent after the refusal is smaller than the whole and holds a subset.
    for (const call of rig.calls.slice(1)) expect(idsOf(call.bytes ?? new Uint8Array()).length).toBeLessThan(3);
  });

  it('control: the in-flight counter does see two requests when they really overlap', async () => {
    const rig = scripted(confirm);
    const { send } = createImportSend(rig.api);
    const made = makePackage({ inspections: 1 });
    await Promise.all([send(made.zip), send(made.zip)]);
    expect(rig.peak()).toBe(2);
  });

  it('control: without a 422 nothing is split', async () => {
    const rig = scripted(confirm);
    await importPackage(makePackage({ inspections: 3 }).zip, deps(rig.api));
    expect(rig.calls.map((c) => idsOf(c.bytes ?? new Uint8Array()).length)).toEqual([3]);
  });

  it('a 404 that names an inspection holds that one back by name and imports the rest', async () => {
    const rig = scripted((_n, ids, bytes) => (ids.includes('insp-1') ? refused(404, 'NOT_FOUND', { inspectionId: 'insp-1' }) : ok(confirmedBody(bytes))));
    const made = makePackage({ inspections: 3 });
    const { report } = await importPackage(made.zip, deps(rig.api));
    expect(report.imported).toEqual(['insp-0', 'insp-2']);
    expect(report.heldBack).toEqual([expect.objectContaining({ id: 'insp-1', reason: 'not_found', status: 404, code: 'NOT_FOUND' })]);
    expectPartition(report, made.ids);
  });

  it('an expired package is refused as a whole, every inspection is held back, and the days are the server figure', async () => {
    const rig = scripted(() => refused(422, 'PACKAGE_EXPIRED', { maxAgeDays: 30 }));
    const made = makePackage({ inspections: 3 });
    const { report } = await importPackage(made.zip, deps(rig.api));
    expect(report.imported).toEqual([]);
    expect(report.heldBack.map((h) => [h.id, h.reason, h.details])).toEqual(made.ids.map((id) => [id, 'package_rejected', { maxAgeDays: 30 }]));
    expect(rig.calls).toHaveLength(1);
  });

  it('a package with inspections whose report was published meanwhile is cut around them: the others are imported, those are held back with the server code', async () => {
    // The engine refuses a package that names a published inspection and lists every one it found (`inspectionIds`), writing nothing.
    const sent: string[][] = [];
    const rig = scripted((_n, ids, bytes) => {
      sent.push(ids);
      const locked = ids.filter((id) => id === 'insp-1' || id === 'insp-3');
      return locked.length > 0
        ? refused(409, 'REPORT_PUBLISHED', { inspectionId: locked[0], inspectionIds: locked })
        : ok(confirmedBody(bytes));
    });
    const made = makePackage({ inspections: 5 });
    const { report } = await importPackage(made.zip, deps(rig.api));
    expect(report.imported.sort()).toEqual(['insp-0', 'insp-2', 'insp-4']);
    expect(report.heldBack.map((h) => [h.id, h.reason, h.status, h.code]).sort()).toEqual([
      ['insp-1', 'refused', 409, 'REPORT_PUBLISHED'],
      ['insp-3', 'refused', 409, 'REPORT_PUBLISHED'],
    ]);
    expect(() => expectPartition(report, made.ids)).not.toThrow();
    // The first request carried everything and was turned down; no later request carried a published inspection.
    expect(sent[0]).toHaveLength(5);
    for (const ids of sent.slice(1)) expect(ids.filter((id) => id === 'insp-1' || id === 'insp-3')).toEqual([]);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('control: when none is published, the same package goes through in one request', async () => {
    const rig = scripted((_n, _ids, bytes) => ok(confirmedBody(bytes)));
    const made = makePackage({ inspections: 5 });
    const { report } = await importPackage(made.zip, deps(rig.api));
    expect(report.imported).toHaveLength(5);
    expect(report.heldBack).toEqual([]);
    expect(rig.calls).toHaveLength(1);
  });

  it('reports a partition of the input across mixed outcomes (property over several scripts)', async () => {
    const scripts: Respond[] = [
      confirm,
      (_n, ids, bytes) => (ids.includes('insp-0') && ids.length > 1 ? refused(409, 'PACKAGE_INSPECTION_DELETED', { inspectionId: 'insp-0', inspectionIds: ['insp-0'] }) : ids.includes('insp-0') ? refused(409, 'PACKAGE_INSPECTION_DELETED', { inspectionId: 'insp-0', inspectionIds: ['insp-0'] }) : ok(confirmedBody(bytes))),
      (n, _ids, bytes) => (n === 1 ? refused(422, 'PACKAGE_TOO_LARGE', { limits: LIMITS }) : n === 3 ? refused(403, 'FORBIDDEN', { inspectionId: 'insp-2' }) : ok(confirmedBody(bytes))),
      () => refused(403, 'FORBIDDEN'),
      () => problem('offline'),
    ];
    for (const [index, script] of scripts.entries()) {
      const made = makePackage({ inspections: 4, photos: { 1: 1 }, updates: { 2: 1 } });
      const { report } = await importPackage(made.zip, deps(scripted(script).api));
      expect(() => expectPartition(report, made.ids), `script ${String(index)}`).not.toThrow();
    }
  });

  it('progress is reported and the first frame is drawn before the first request', async () => {
    const order: string[] = [];
    const rig = scripted((_n, _ids, bytes) => (order.push('send'), ok(confirmedBody(bytes))));
    const progress: Array<{ settled: number; imported: number; heldBack: number; pending: number }> = [];
    const made = makePackage({ inspections: 2 });
    await importPackage(made.zip, deps(rig.api, { nextFrame: () => (order.push('frame'), Promise.resolve()) }), (p) => progress.push(p));
    expect(order).toEqual(['frame', 'send']);
    expect(progress.at(-1)).toMatchObject({ imported: 2, heldBack: 0, pending: 0 });
  });
});

describe('a problem that is not a network fault stops the import', () => {
  it.each(['auth', 'locked', 'upgrade', 'server_too_old'] as const)('"%s": one attempt, no waiting, the reason is reported', async (p) => {
    const rig = scripted(() => problem(p));
    const d = deps(rig.api);
    const made = makePackage({ inspections: 3 });
    const { report, stopped } = await importPackage(made.zip, d);
    expect(stopped).toBe(p);
    expect(rig.calls).toHaveLength(1);
    expect(d.sleeps).toEqual([]);
    expect(report.imported).toEqual([]);
    expectPartition(report, made.ids);
  });

  it('control: a network fault ("offline") is retried up to the shared limit, with waits, and is not a stop', async () => {
    const rig = scripted(() => problem('offline'));
    const d = deps(rig.api);
    const made = makePackage({ inspections: 2 });
    const { report, stopped } = await importPackage(made.zip, d);
    expect(stopped).toBeNull();
    expect(rig.calls).toHaveLength(5);
    expect(d.sleeps.length).toBe(4);
    expect(report.heldBack.every((h) => h.reason === 'gave_up')).toBe(true);
  });

  it('a stop part-way keeps what was already confirmed as imported', async () => {
    const rig = scripted((n, _ids, bytes) => (n === 1 ? refused(422, 'PACKAGE_TOO_LARGE', { limits: LIMITS }) : n === 2 ? ok(confirmedBody(bytes)) : problem('auth')));
    const made = makePackage({ inspections: 3 });
    const { report, stopped } = await importPackage(made.zip, deps(rig.api));
    expect(stopped).toBe('auth');
    expect(report.imported).toEqual(['insp-0']);
    expectPartition(report, made.ids);
    // The calls after the stop never reached the api.
    expect(rig.calls).toHaveLength(3);
  });
});

describe('which inspections a request went out for', () => {
  it('a stop with no request ever sent leaves the sent set empty', async () => {
    const rig = scripted(() => problem('auth'));
    const made = makePackage({ inspections: 3 });
    const outcome = await importPackage(made.zip, deps(rig.api));
    expect(outcome.stopped).toBe('auth');
    expect([...outcome.requested]).toEqual([]);
  });

  it('a request that lost its answer and was then stopped counts as sent for every inspection in that part', async () => {
    const rig = scripted((n) => (n === 1 ? problem('offline') : problem('auth')));
    const made = makePackage({ inspections: 3 });
    const outcome = await importPackage(made.zip, deps(rig.api));
    expect(outcome.stopped).toBe('auth');
    expect([...outcome.requested].sort()).toEqual(made.ids);
  });

  it('a refused whole-package request already counts every inspection in it as sent', async () => {
    const rig = scripted((n, _ids, bytes) => (n === 1 ? refused(422, 'PACKAGE_TOO_LARGE', { limits: LIMITS }) : n === 2 ? ok(confirmedBody(bytes)) : problem('auth')));
    const made = makePackage({ inspections: 3 });
    const outcome = await importPackage(made.zip, deps(rig.api));
    expect(outcome.stopped).toBe('auth');
    // The first request carried the whole package, so each inspection in it was sent at least once.
    expect([...outcome.requested].sort()).toEqual(['insp-0', 'insp-1', 'insp-2']);
  });
});

describe('the package belongs to this account?', () => {
  it('matches only the tenant of the signed-in account', () => {
    const summary = makePackage({ inspections: 1, tenantId: 'tenant-1' }).summary;
    expect(tenantMatches(summary, 'tenant-1')).toBe(true);
    expect(tenantMatches(summary, 'tenant-2')).toBe(false);
    expect(tenantMatches(summary, '')).toBe(false);
  });
});
