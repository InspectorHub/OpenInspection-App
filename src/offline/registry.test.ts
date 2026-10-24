import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_GLOBAL_OPS,
  DEFAULT_REGISTRY,
  INSPECTION_COMPLETE,
  INSPECTION_CREATE,
  INSPECTION_UPDATE,
  MAX_PAYLOAD_BYTES,
  RESERVED_INSPECTION_IDS,
  RegistryError,
  findCommand,
  isLocalId,
  pathFor,
  payloadBytes,
  validateCommand,
  type CommandDef,
  type CommandRegistry,
} from './registry';
import { check, type Document } from './test-support/schema-check';

interface Snapshot extends Document {
  paths: Record<string, Record<string, { requestBody?: { content: { 'application/json': { schema: Record<string, unknown> } } } }>>;
}

const snapshot = JSON.parse(readFileSync(new URL('./test-support/native-contract.snapshot.json', import.meta.url), 'utf8')) as Snapshot;
const counter = () => {
  let n = 0;
  return () => `generated-${String((n += 1))}`;
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RegistryError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('the registry lists exactly the first-version commands', () => {
  it('has the three NEVER_BLOCK inspection commands, each at registry version 1', () => {
    expect(DEFAULT_REGISTRY.map((d) => `${d.method} ${d.pathTemplate} ${d.op}`)).toEqual([
      'POST /api/inspections inspection.create',
      'PATCH /api/inspections/{id} inspection.update',
      'POST /api/inspections/{id}/complete inspection.complete',
    ]);
    for (const def of DEFAULT_REGISTRY) {
      expect(def.registryVersion).toBe(1);
      expect(def.neverBlock).toBe(true);
      expect(def.idempotency).toBe('safe_to_repeat');
    }
    expect(new Set(DEFAULT_REGISTRY.map((d) => d.op)).size).toBe(DEFAULT_REGISTRY.length);
  });

  it('only one command creates the inspection', () => {
    expect(DEFAULT_REGISTRY.filter((d) => d.createsInspection === true).map((d) => d.op)).toEqual(['inspection.create']);
  });
});

describe('P0-2: every command maps to an inspection id or is an explicitly global one', () => {
  it('enumerates the registry: an inspection-bound op yields the id of its sample, any other op must be on the allow list', () => {
    expect(ALLOWED_GLOBAL_OPS).toEqual([]);
    for (const def of DEFAULT_REGISTRY) {
      const sample = def.parse(def.sample);
      if (def.scope === 'inspection') {
        expect(def.inspectionIdOf(sample), def.op).toBe('local-1');
        expect(isLocalId(def.inspectionIdOf(sample)), def.op).toBe(true);
      } else {
        expect(ALLOWED_GLOBAL_OPS, def.op).toContain(def.op);
      }
    }
  });

  it('a command without a mapping is caught by the same enumeration (positive control)', () => {
    const unmapped: CommandDef = { ...INSPECTION_COMPLETE, op: 'inspection.archive', inspectionIdOf: () => null };
    const registry: CommandRegistry = [...DEFAULT_REGISTRY, unmapped];
    const failures = registry.filter((def) => def.scope === 'inspection' && def.inspectionIdOf(def.parse(def.sample)) === null).map((d) => d.op);
    expect(failures).toEqual(['inspection.archive']);
    expect(codeOf(() => validateCommand(registry, 'inspection.archive', { inspectionId: 'local-1' }, counter()))).toBe('invalid_inspection_id');
  });

  it.each([
    ['inspection.complete', {}],
    ['inspection.complete', { inspectionId: '' }],
    ['inspection.complete', { inspectionId: '../x' }],
    ['inspection.complete', { inspectionId: 'a'.repeat(65) }],
    ['inspection.complete', { inspectionId: 12 }],
    ['inspection.update', { changes: { propertyAddress: '14 Test Street' } }],
    ['inspection.update', { inspectionId: 'a/b', changes: { propertyAddress: '14 Test Street' } }],
  ])('enqueue fails closed for %s with %j', (op, payload) => {
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, op, payload, counter()))).toBe('invalid_payload');
  });

  it('accepts a charset-valid id (positive control for the rows above)', () => {
    const ok = validateCommand(DEFAULT_REGISTRY, 'inspection.complete', { inspectionId: 'Abc_-123' }, counter());
    expect(ok.inspectionId).toBe('Abc_-123');
  });
});

describe('drift against the committed snapshot of the server contract', () => {
  it('every command method and route exists in the snapshot', () => {
    for (const def of DEFAULT_REGISTRY) {
      const operation = snapshot.paths[def.pathTemplate]?.[def.method.toLowerCase()];
      expect(operation, `${def.method} ${def.pathTemplate} is missing from the snapshot; add it to scripts/sync-contract-fixture.mjs`).toBeDefined();
    }
  });

  it('the snapshot carries no route the registry does not use', () => {
    const used = new Set(DEFAULT_REGISTRY.map((d) => `${d.method.toLowerCase()} ${d.pathTemplate}`));
    const inSnapshot = Object.entries(snapshot.paths).flatMap(([route, methods]) => Object.keys(methods).map((m) => `${m} ${route}`));
    expect(new Set(inSnapshot)).toEqual(used);
  });

  it('the request body of every command, built from its minimal valid payload, satisfies the server request schema', () => {
    for (const def of DEFAULT_REGISTRY) {
      const operation = snapshot.paths[def.pathTemplate]?.[def.method.toLowerCase()];
      const body = def.body(def.parse(def.sample));
      const schema = operation?.requestBody?.content['application/json'].schema;
      if (body === undefined) {
        expect(operation?.requestBody, def.op).toBeUndefined();
      } else {
        expect(schema, def.op).toBeDefined();
        expect(check(snapshot, schema ?? {}, body), def.op).toEqual([]);
      }
    }
  });

  it('a payload the server would refuse fails the same checker (positive control)', () => {
    const schema = snapshot.paths['/api/inspections']?.post?.requestBody?.content['application/json'].schema ?? {};
    expect(check(snapshot, schema, { id: 'local-1', propertyAddress: 'abc', templateId: 't' })).not.toEqual([]);
    expect(check(snapshot, schema, { id: 'bad id', propertyAddress: '12 Test Street', templateId: 't' })).not.toEqual([]);
    expect(check(snapshot, schema, { id: 'local-1', propertyAddress: '12 Test Street' })).not.toEqual([]);
  });

  it('every field a payload parser lets through exists in the server schema, and the server required fields are required here', () => {
    const create = snapshot.components.schemas.CreateInspection as { properties: Record<string, unknown>; required: string[] };
    const update = snapshot.components.schemas.UpdateInspection as { properties: Record<string, unknown> };
    const full = INSPECTION_CREATE.parse({
      id: 'x1',
      propertyAddress: '12 Test Street',
      clientName: 'A',
      clientEmail: 'a@b.co',
      clientPhone: '1',
      templateId: 't',
      inspectorId: 'i',
      date: '2026-10-25T10:00:00Z',
      propertyType: 'commercial',
      addressPlaceId: 'p',
      addressStreet: 's',
      addressCity: 'c',
      addressState: 'st',
      addressZip: 'z',
      addressCounty: 'co',
      addressLat: 1,
      addressLng: 2,
      serviceIds: ['a'],
    });
    for (const key of Object.keys(full)) expect(Object.keys(create.properties), key).toContain(key);
    for (const key of create.required) expect(codeOf(() => INSPECTION_CREATE.parse({ ...full, [key]: undefined })), key).toBe('invalid_payload');
    const changes = INSPECTION_UPDATE.parse({
      inspectionId: 'x1',
      changes: {
        propertyAddress: '12 Test Street',
        date: '2026-10-25',
        inspectorId: null,
        propertyType: null,
        yearBuilt: 1990,
        sqft: 1,
        foundationType: 'slab',
        bedrooms: 1,
        bathrooms: 1.5,
        lotSize: 'x',
        unit: 'x',
        county: 'x',
        closingDate: '2026-10-25',
        referenceNumber: 'x',
      },
    }).changes as Record<string, unknown>;
    for (const key of Object.keys(changes)) expect(Object.keys(update.properties), key).toContain(key);
    expect(Object.keys(changes)).toHaveLength(14);
  });
});

describe('inspection.create payload', () => {
  const valid = { id: 'local-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

  it('strips unknown keys, including tenant, money and policy overrides', () => {
    const out = INSPECTION_CREATE.parse({ ...valid, tenantId: 'other', price: 1, discountAmount: 5, paymentRequired: true, client: { name: 'x' }, extra: 1 });
    expect(out).toEqual(valid);
  });

  it('generates a local id with the injected source when none is given, and keeps a given one', () => {
    const made = validateCommand(DEFAULT_REGISTRY, 'inspection.create', { propertyAddress: '12 Test Street', templateId: 't' }, counter());
    expect(made.payload.id).toBe('generated-1');
    expect(made.inspectionId).toBe('generated-1');
    expect(validateCommand(DEFAULT_REGISTRY, 'inspection.create', valid, counter()).payload.id).toBe('local-1');
  });

  it('a real crypto.randomUUID id satisfies the charset', () => {
    expect(isLocalId(crypto.randomUUID())).toBe(true);
  });

  it.each([
    ['short address', { propertyAddress: 'abc' }],
    ['long address', { propertyAddress: 'a'.repeat(301) }],
    ['empty template', { templateId: '' }],
    ['bad id', { id: 'a b' }],
    ['long phone', { clientPhone: '1'.repeat(31) }],
    ['bad email', { clientEmail: 'not-an-email' }],
    ['offset date', { date: '2026-10-25T10:00:00+02:00' }],
    ['date only', { date: '2026-10-25' }],
    ['date without seconds (the engine datetime requires them)', { date: '2026-10-25T10:00Z' }],
    ['date without seconds, with minutes only and a fraction', { date: '2026-10-25T10:00.5Z' }],
    ['bad property type', { propertyType: 'castle' }],
    ['latitude out of range', { addressLat: 91 }],
    ['too many services', { serviceIds: Array.from({ length: 51 }, (_, i) => `s${String(i)}`) }],
    ['non-string service', { serviceIds: [1] }],
    ['long state', { addressState: 'x'.repeat(11) }],
  ])('refuses %s', (_name, patch) => {
    expect(codeOf(() => INSPECTION_CREATE.parse({ ...valid, ...patch }))).toBe('invalid_payload');
  });

  it('accepts the boundaries (positive control for the refusals)', () => {
    const edge = INSPECTION_CREATE.parse({
      ...valid,
      id: 'a'.repeat(64),
      propertyAddress: 'a'.repeat(5),
      clientPhone: '1'.repeat(30),
      clientEmail: '',
      date: '2026-10-25T10:00:00.123Z',
      addressLat: -90,
      serviceIds: Array.from({ length: 50 }, (_, i) => `s${String(i)}`),
    });
    expect(edge.id).toBe('a'.repeat(64));
  });

  it('refuses a non-object with a fixed code and accepts a large but bounded one', () => {
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.create', 'text', counter()))).toBe('invalid_payload');
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.create', [], counter()))).toBe('invalid_payload');
    const big = { ...valid, serviceIds: Array.from({ length: 50 }, () => 'x'.repeat(128)), addressStreet: 'y'.repeat(200), addressPlaceId: 'z'.repeat(200) };
    expect(validateCommand(DEFAULT_REGISTRY, 'inspection.create', big, counter()).payload.serviceIds).toHaveLength(50);
  });

  it('refuses a payload over the byte cap', () => {
    const wide: CommandDef = { ...INSPECTION_CREATE, parse: (input) => input as Record<string, unknown> };
    const registry: CommandRegistry = [wide];
    const oversize = { id: 'local-1', blob: String.fromCharCode(233).repeat(MAX_PAYLOAD_BYTES) };
    expect(codeOf(() => validateCommand(registry, 'inspection.create', oversize, counter()))).toBe('payload_too_large');
    expect(validateCommand(registry, 'inspection.create', { id: 'local-1', blob: String.fromCharCode(233) }, counter()).inspectionId).toBe('local-1');
  });

  it('the payload cap is exact: the cap itself is accepted, one byte more is refused', () => {
    const wide: CommandDef = { ...INSPECTION_CREATE, parse: (input) => input as Record<string, unknown> };
    const registry: CommandRegistry = [wide];
    const base = payloadBytes({ id: 'local-1', blob: '' });
    const atCap = { id: 'local-1', blob: 'x'.repeat(MAX_PAYLOAD_BYTES - base) };
    expect(payloadBytes(atCap)).toBe(MAX_PAYLOAD_BYTES);
    expect(validateCommand(registry, 'inspection.create', atCap, counter()).inspectionId).toBe('local-1');
    expect(codeOf(() => validateCommand(registry, 'inspection.create', { id: 'local-1', blob: 'x'.repeat(MAX_PAYLOAD_BYTES - base + 1) }, counter()))).toBe('payload_too_large');
  });

  it('an unknown op is refused', () => {
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.delete', { inspectionId: 'a' }, counter()))).toBe('unknown_op');
    expect(findCommand(DEFAULT_REGISTRY, 'inspection.complete')).toBe(INSPECTION_COMPLETE);
  });
});

describe('M-1: ids the engine reserves as route segments are refused, fail closed', () => {
  const valid = { id: 'local-1', propertyAddress: '12 Test Street', templateId: 'template-1' };
  const RESERVED = ['bulk', 'counts', 'dashboard', 'inspectors', 'schedule-conflicts', 'templates', 'wizard'];

  it('the list is the engine list (RESERVED_INSPECTION_SEGMENTS in the engine, server/lib/inspection/reserved-segments.ts)', () => {
    expect([...RESERVED_INSPECTION_IDS].sort()).toEqual([...RESERVED].sort());
  });

  it.each(RESERVED)('%s is not a local id, so it cannot be supplied, generated or patched', (id) => {
    expect(isLocalId(id)).toBe(false);
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.create', { ...valid, id }, counter()))).toBe('invalid_payload');
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.create', { propertyAddress: valid.propertyAddress, templateId: valid.templateId }, () => id))).toBe('invalid_payload');
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.update', { inspectionId: id, changes: { sqft: 1 } }, counter()))).toBe('invalid_payload');
    expect(codeOf(() => validateCommand(DEFAULT_REGISTRY, 'inspection.complete', { inspectionId: id }, counter()))).toBe('invalid_payload');
    expect(INSPECTION_UPDATE.inspectionIdOf({ inspectionId: id })).toBeNull();
    expect(INSPECTION_COMPLETE.inspectionIdOf({ inspectionId: id })).toBeNull();
    expect(INSPECTION_CREATE.inspectionIdOf({ id })).toBeNull();
    expect(codeOf(() => pathFor(INSPECTION_COMPLETE, id))).toBe('invalid_inspection_id');
  });

  it('positive controls: near misses and ordinary ids are still ids', () => {
    for (const id of ['Bulk', 'bulk-1', 'my-bulk', 'counts2', 'template', 'schedule_conflicts', 'wizards', 'a', crypto.randomUUID()]) {
      expect(isLocalId(id)).toBe(true);
      expect(validateCommand(DEFAULT_REGISTRY, 'inspection.complete', { inspectionId: id }, counter()).inspectionId).toBe(id);
    }
    expect(validateCommand(DEFAULT_REGISTRY, 'inspection.create', { ...valid, id: 'templates-1' }, counter()).inspectionId).toBe('templates-1');
  });
});

describe('inspection.update and inspection.complete payloads', () => {
  it('update needs at least one known change and drops the rest', () => {
    expect(codeOf(() => INSPECTION_UPDATE.parse({ inspectionId: 'a', changes: {} }))).toBe('invalid_payload');
    expect(codeOf(() => INSPECTION_UPDATE.parse({ inspectionId: 'a', changes: { status: 'cancelled', price: 1 } }))).toBe('invalid_payload');
    expect(INSPECTION_UPDATE.parse({ inspectionId: 'a', changes: { sqft: 10, status: 'cancelled', price: 1 }, extra: true })).toEqual({ inspectionId: 'a', changes: { sqft: 10 } });
  });

  it('the update body is the changes only and complete has no body', () => {
    expect(INSPECTION_UPDATE.body({ inspectionId: 'a', changes: { sqft: 10 } })).toEqual({ sqft: 10 });
    expect(INSPECTION_COMPLETE.body({ inspectionId: 'a' })).toBeUndefined();
  });

  it.each([
    ['yearBuilt', 1799],
    ['yearBuilt', 2101],
    ['sqft', -1],
    ['bathrooms', 21],
    ['closingDate', '10/25/2026'],
    ['date', '2026-13-45'],
    ['foundationType', 'raft'],
  ])('refuses %s = %j', (key, value) => {
    expect(codeOf(() => INSPECTION_UPDATE.parse({ inspectionId: 'a', changes: { [key]: value } }))).toBe('invalid_payload');
  });
});

describe('the replay url is built from the template and the validated id only', () => {
  it('substitutes the id into the template', () => {
    expect(pathFor(INSPECTION_UPDATE, 'abc_-9')).toBe('/api/inspections/abc_-9');
    expect(pathFor(INSPECTION_COMPLETE, 'abc_-9')).toBe('/api/inspections/abc_-9/complete');
    expect(pathFor(INSPECTION_CREATE, 'abc_-9')).toBe('/api/inspections');
  });

  it.each(['../admin', 'a/b', 'a?x=1', 'a#b', '%2e%2e', 'a b', '', 'a\n'])('refuses to build a path for the id %j', (id) => {
    expect(codeOf(() => pathFor(INSPECTION_COMPLETE, id))).toBe('invalid_inspection_id');
  });

  it('refuses a null id for a route that needs one', () => {
    expect(codeOf(() => pathFor(INSPECTION_COMPLETE, null))).toBe('invalid_inspection_id');
  });
});
