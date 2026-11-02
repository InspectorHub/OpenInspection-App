import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePackage } from '../../src/offline/test-support/import-fixtures';
import { scenarios, startRendererEngine, type RendererEngine } from './engine';

/**
 * Does the fake engine answer the way the real engine's CONTRACT says? The contract is `contracts/native-contract.openapi.json` in the
 * engine repo (generated from its routes, and kept current by its own gates). The fake's answers are checked two ways:
 *  - at compile time, by `contract<...>()` in engine.ts against src/api/schema.d.ts (the SHAPE of 19 routes);
 *  - here, at run time, against the contract's own JSON schemas (the VALUES: a required field left out, a null where the contract says
 *    absent, a string where it says a number), for the routes below.
 * The contract is not committed in this repo (it is 800 KB and lives in the engine). Point OPENINSPECTION_CONTRACT at a copy or a URL:
 *   OPENINSPECTION_CONTRACT=../OpenInspection/contracts/native-contract.openapi.json npx vitest run e2e/fake-engine/contract.test.ts
 * CI sets it and also sets REQUIRE_ENGINE_CONTRACT=1: then a missing contract or too few checked routes is a FAILURE, never a skip.
 */
const SOURCE = process.env.OPENINSPECTION_CONTRACT;
const REQUIRED = process.env.REQUIRE_ENGINE_CONTRACT === '1';
const AUTH = { authorization: 'Bearer renderer-access-token' };

interface Probe {
  /** The route as the fake engine serves it. */
  path: string;
  method: 'GET' | 'POST';
  /** The same route as the contract writes it. */
  contractPath: string;
  status: number;
  headers?: Record<string, string>;
  body?: () => { content: string | Uint8Array; type: string };
}

const JSON_BODY = (value: unknown) => () => ({ content: JSON.stringify(value), type: 'application/json' });
const PROBES: Probe[] = [
  { path: '/api/client/compat', method: 'GET', contractPath: '/api/client/compat', status: 200 },
  { path: '/api/client/session', method: 'GET', contractPath: '/api/client/session', status: 200, headers: AUTH },
  { path: '/api/session/context', method: 'GET', contractPath: '/api/session/context', status: 200, headers: AUTH },
  { path: '/api/tags', method: 'GET', contractPath: '/api/tags', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7/tags', method: 'GET', contractPath: '/api/inspections/{id}/tags', status: 200, headers: AUTH },
  { path: '/api/recommendations', method: 'GET', contractPath: '/api/recommendations', status: 200, headers: AUTH },
  { path: '/api/contractor-types', method: 'GET', contractPath: '/api/contractor-types', status: 200, headers: AUTH },
  { path: '/api/admin/defect-categories', method: 'GET', contractPath: '/api/admin/defect-categories', status: 200, headers: AUTH },
  { path: '/api/inspections', method: 'GET', contractPath: '/api/inspections', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7', method: 'GET', contractPath: '/api/inspections/{id}', status: 200, headers: AUTH },
  { path: '/api/inspections/templates', method: 'GET', contractPath: '/api/inspections/templates', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7/results', method: 'GET', contractPath: '/api/inspections/{id}/results', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7/report-data', method: 'GET', contractPath: '/api/inspections/{id}/report-data', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7/media', method: 'GET', contractPath: '/api/inspections/{id}/media', status: 200, headers: AUTH },
  { path: '/api/inspections/insp-7/collab/ticket', method: 'POST', contractPath: '/api/inspections/{id}/collab/ticket', status: 200, headers: AUTH, body: JSON_BODY({}) },
  { path: '/api/inspections/insp-7/media/upload-url', method: 'POST', contractPath: '/api/inspections/{id}/media/upload-url', status: 200, headers: AUTH, body: JSON_BODY({ pendingId: 'pending-1', contentType: 'image/jpeg' }) },
  { path: '/api/client/inspections/visible', method: 'POST', contractPath: '/api/client/inspections/visible', status: 200, headers: AUTH, body: JSON_BODY({ ids: ['insp-7'] }) },
  { path: '/api/client/import', method: 'POST', contractPath: '/api/client/import', status: 200, headers: AUTH, body: () => ({ content: makePackage({ inspections: 1 }).zip, type: 'application/zip' }) },
];

/** Routes whose success body is bound to the contract's TYPE in engine.ts but not probed here (they need a prior upload or a multipart body). */
const TYPE_BOUND_ONLY = ['POST /api/inspections/{id}/cover'];
/** Routes the fake serves that the contract does not describe at all (the sign-in protocol, a token-addressed upload, the photo bytes): unguarded. */
const OUTSIDE_THE_CONTRACT = ['GET /oauth/authorize', 'POST /oauth/register', 'POST /oauth/token', 'POST /api/public/uploads/photo', 'GET /api/inspections/{id}/photo'];

/**
 * Ajv refuses `nullable` on a schema that has no `type` (the contract writes "anything, or null" that way). Such a schema has no type to
 * be null OF, so it accepts any value already: the keyword is dropped. Nothing else is changed.
 */
function withoutTypelessNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutTypelessNullable);
  if (typeof node !== 'object' || node === null) return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) copy[key] = withoutTypelessNullable(value);
  if ('nullable' in copy && !('type' in copy) && !('$ref' in copy) && !('allOf' in copy) && !('oneOf' in copy) && !('anyOf' in copy)) delete copy.nullable;
  return copy;
}

async function loadContract(source: string): Promise<any> {
  if (/^https?:\/\//.test(source)) {
    // A few tries: a hiccup of the host must not fail every pull request. A contract that is really unavailable still fails, after the last one.
    let failure = 'no attempt was made';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const reply = await fetch(source);
        if (reply.ok) return withoutTypelessNullable(await reply.json());
        failure = `HTTP ${String(reply.status)}`;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
    throw new Error(`the contract could not be fetched from ${source}: ${failure}`);
  }
  return withoutTypelessNullable(JSON.parse(readFileSync(source, 'utf8')));
}

describe.skipIf(SOURCE === undefined && !REQUIRED)('the fake engine against the engine contract (run time)', () => {
  let contract: any;
  let engine: RendererEngine;
  let ajv: Ajv;

  beforeAll(async () => {
    if (SOURCE === undefined) throw new Error('REQUIRE_ENGINE_CONTRACT=1 but OPENINSPECTION_CONTRACT is not set: nothing would be checked');
    contract = await loadContract(SOURCE);
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    engine = await startRendererEngine({ ...scenarios.inspection });
  });
  afterAll(async () => {
    await engine?.close?.();
  });

  /** Probe label -> matched. Filled by each probe; a probe that did not run (a filtered run) is simply absent. */
  const checked = new Set<string>();
  it.each(PROBES)('$method $path answers as the contract says', async (probe) => {
    const operation = contract.paths?.[probe.contractPath]?.[probe.method.toLowerCase()];
    expect(operation, `${probe.method} ${probe.contractPath} is not in the contract (renamed or removed there?)`).toBeDefined();
    const declared = operation.responses?.[String(probe.status)]?.content?.['application/json']?.schema;
    expect(declared, `the contract has no JSON schema for ${String(probe.status)} of ${probe.method} ${probe.contractPath}`).toBeDefined();

    const body = probe.body?.();
    const reply = await fetch(`${engine.url}${probe.path}`, {
      method: probe.method,
      headers: { ...(probe.headers ?? {}), ...(body === undefined ? {} : { 'content-type': body.type }) },
      ...(body === undefined ? {} : { body: body.content as BodyInit }),
    });
    expect(reply.status).toBe(probe.status);
    const answer: unknown = await reply.json();

    // The schema is compiled with the contract's components next to it, so its "#/components/schemas/..." references resolve.
    const validate = ajv.compile({ ...declared, components: contract.components });
    const valid = validate(answer);
    expect(valid, `${probe.method} ${probe.path} does not match the contract:\n${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    checked.add(`${probe.method} ${probe.path}`);
  });

  it('probes enough routes, each exactly once, and names what it does not check', () => {
    // Both numbers, always: what was probed, and what was checked so far (a filtered run checks fewer; the probes themselves fail when wrong).
    console.log(`fake engine contract check: ${String(PROBES.length)} routes probed, ${String(checked.size)} matched in this run; type-bound only: ${TYPE_BOUND_ONLY.join(', ')}; outside the contract: ${OUTSIDE_THE_CONTRACT.join(', ')}`);
    expect(new Set(PROBES.map((probe) => `${probe.method} ${probe.path}`)).size).toBe(PROBES.length);
    expect(PROBES.length).toBeGreaterThanOrEqual(15);
  });

  it('control: the heavy shapes are enforced too (report-data and the session context lose a required block, and are refused)', async () => {
    for (const probe of PROBES.filter((p) => p.contractPath === '/api/inspections/{id}/report-data' || p.contractPath === '/api/session/context')) {
      const declared = contract.paths[probe.contractPath].get.responses['200'].content['application/json'].schema;
      const validate = ajv.compile({ ...declared, components: contract.components });
      const reply = await fetch(`${engine.url}${probe.path}`, { headers: probe.headers ?? {} });
      const answer = (await reply.json()) as { data: Record<string, unknown> };
      expect(validate(answer), `${probe.path} should match before the block is removed`).toBe(true);
      const resolve = (schema: any): any => (schema?.$ref ? contract.components.schemas[String(schema.$ref).split('/').pop() as string] : schema);
      const dataSchema = resolve(resolve(declared).properties.data);
      const required = Object.keys(answer.data).filter((key) => (dataSchema.required as string[] | undefined)?.includes(key));
      expect(required.length, `${probe.path}: no required block found to remove`).toBeGreaterThan(0);
      for (const key of required) {
        const { [key]: _removed, ...rest } = answer.data;
        expect(validate({ ...answer, data: rest }), `${probe.path} without ${key} should be refused`).toBe(false);
      }
    }
  });

  it('control: a body that breaks the contract IS reported (the check can fail)', () => {
    const declared = contract.paths['/api/client/session'].get.responses['200'].content['application/json'].schema;
    const validate = ajv.compile({ ...declared, components: contract.components });
    expect(validate({ success: true, data: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 30, serverNowMs: 1 } })).toBe(false); // tenantName is required
    expect(validate({ success: true, data: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 'thirty', tenantName: null, serverNowMs: 1 } })).toBe(false);
    expect(validate({ success: true, data: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 30, tenantName: null, serverNowMs: 1 } })).toBe(true);
  });
});
