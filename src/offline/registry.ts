/**
 * The commands the outbox may queue while offline, and nothing else: a write that is not listed here is
 * answered `needs_connection` by the data source instead of being queued.
 *
 * Every entry names the one server route it replays to, the shape of its payload (validated and stripped of
 * unknown keys at enqueue and again at replay), how to find the inspection it belongs to, whether repeating
 * it is harmless, and whether the server's client-version guard may refuse it. The drift test checks each
 * entry against the committed snapshot of the server's native contract.
 */

export const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A queued payload is a handful of form fields; this bounds what a bug or a hostile caller can park on the device. */
export const MAX_PAYLOAD_BYTES = 16_384;

/**
 * The static first segments under `/api/inspections`: routes, never inspection ids. A copy of the engine's
 * `RESERVED_INSPECTION_SEGMENTS` (server/lib/inspection/reserved-segments.ts), which refuses a client-generated id
 * equal to one of them. Refusing it here too means such a write is never queued, rather than queued and failed
 * for good at replay. Keep the two lists equal.
 */
export const RESERVED_INSPECTION_IDS: ReadonlySet<string> = new Set(['bulk', 'counts', 'dashboard', 'inspectors', 'schedule-conflicts', 'templates', 'wizard']);

/** A well-formed id that is not a reserved route segment. Every id the registry accepts, finds or puts in a url passes through here. */
export function isLocalId(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_ID_PATTERN.test(value) && !RESERVED_INSPECTION_IDS.has(value);
}

export type RegistryErrorCode = 'unknown_op' | 'invalid_payload' | 'invalid_inspection_id' | 'payload_too_large';

/** Carries a fixed code only; the offending value is never part of the message. */
export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode) {
    super(`Registry refused the command: ${code}`);
    this.name = 'RegistryError';
  }
}

export type IdempotencyClass =
  /** Sending it again after it was applied changes nothing (the id, the status or last-writer-wins sees to that). */
  | 'safe_to_repeat'
  /** A repeat would apply it twice; only the Idempotency-Key protects it. */
  | 'once_only';

export type Payload = Readonly<Record<string, unknown>>;

export interface CommandDef {
  op: string;
  method: 'POST' | 'PATCH';
  /** The route, with `{id}` standing for the inspection id when the route has one. */
  pathTemplate: string;
  scope: 'inspection' | 'global';
  idempotency: IdempotencyClass;
  /** True when the server's version guard never answers 426 for this route; a 426 for it is not a reason to halt the queue. */
  neverBlock: boolean;
  /** The payload layout this entry understands. A queued row written under another version is not replayed. */
  registryVersion: number;
  /** True for the command that brings the inspection into existence on the server. */
  createsInspection?: boolean;
  /** Fills in what the device generates (a local id) before validation. */
  prepare?(input: Payload, newId: () => string): Payload;
  /** Validates and returns a copy that holds only known keys. Throws `RegistryError('invalid_payload')`. */
  parse(input: unknown): Payload;
  /** The inspection the payload belongs to, or null when it holds none that is well formed. */
  inspectionIdOf(payload: Payload): string | null;
  /** The JSON request body, or undefined for a route without one. */
  body(payload: Payload): unknown;
  /** A minimal valid payload; the drift test sends it through the snapshot's request schema. */
  sample: Payload;
}

export type CommandRegistry = readonly CommandDef[];

/** Ops that deliberately belong to no inspection. The registry test fails for an unlisted op without an inspection id. */
export const ALLOWED_GLOBAL_OPS: readonly string[] = [];

type Field = (value: unknown) => unknown;

function invalid(): never {
  throw new RegistryError('invalid_payload');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str =
  (min: number, max: number): Field =>
  (value) =>
    typeof value === 'string' && value.length >= min && value.length <= max ? value : invalid();

const oneOf =
  (allowed: readonly string[]): Field =>
  (value) =>
    typeof value === 'string' && allowed.includes(value) ? value : invalid();

const int =
  (min: number, max: number): Field =>
  (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : invalid();

const num =
  (min: number, max: number): Field =>
  (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : invalid();

const nullable =
  (inner: Field): Field =>
  (value) =>
    value === null ? null : inner(value);

const localId: Field = (value) => (isLocalId(value) ? value : invalid());

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const email: Field = (value) => (typeof value === 'string' && value.length <= 254 && (value === '' || EMAIL.test(value)) ? value : invalid());

// Seconds are required, as the engine's datetime check requires them: '10:00Z' would be accepted here and refused there.
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** UTC only: an offset form is not promised by the contract, and a refusal here would strand a person's write. */
const dateTime: Field = (value) => (typeof value === 'string' && UTC_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : invalid());
const civilDate: Field = (value) => (typeof value === 'string' && CIVIL_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : invalid());
const dateOrDateTime: Field = (value) => (typeof value === 'string' && CIVIL_DATE.test(value) ? civilDate(value) : dateTime(value));

const stringList =
  (maxItems: number, item: Field): Field =>
  (value) =>
    Array.isArray(value) && value.length <= maxItems ? value.map((entry: unknown) => item(entry)) : invalid();

/** Keeps only the listed keys; a listed key present with `undefined` counts as absent. */
function shape(fields: Readonly<Record<string, Field>>, required: readonly string[]): (input: unknown) => Record<string, unknown> {
  return (input) => {
    if (!isRecord(input)) return invalid();
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(fields)) {
      const value = input[key];
      if (value === undefined) continue;
      out[key] = check(value);
    }
    for (const key of required) if (!(key in out)) invalid();
    return out;
  };
}

const PROPERTY_TYPES = ['single_family', 'multi_unit', 'commercial'];
const FOUNDATIONS = ['basement', 'slab', 'crawlspace', 'other'];

/**
 * Only the fields a person fills in on site. Money, discounts, payment and agreement switches, inline
 * contacts and anything the server decides are not in this list and are therefore dropped, so a queued
 * create can never carry a tenant, a price or a policy override.
 */
const createFields: Readonly<Record<string, Field>> = {
  id: localId,
  propertyAddress: str(5, 300),
  clientName: str(1, 200),
  clientEmail: nullable(email),
  clientPhone: nullable(str(0, 30)),
  templateId: str(1, 128),
  inspectorId: str(1, 128),
  date: dateTime,
  propertyType: nullable(oneOf(PROPERTY_TYPES)),
  addressPlaceId: nullable(str(1, 200)),
  addressStreet: nullable(str(0, 200)),
  addressCity: nullable(str(0, 100)),
  addressState: nullable(str(0, 10)),
  addressZip: nullable(str(0, 20)),
  addressCounty: nullable(str(0, 100)),
  addressLat: nullable(num(-90, 90)),
  addressLng: nullable(num(-180, 180)),
  serviceIds: stringList(50, str(1, 128)),
};

const updateFields: Readonly<Record<string, Field>> = {
  propertyAddress: str(5, 300),
  date: dateOrDateTime,
  inspectorId: nullable(str(1, 128)),
  propertyType: nullable(oneOf(PROPERTY_TYPES)),
  yearBuilt: nullable(int(1800, 2100)),
  sqft: nullable(int(0, 10_000_000)),
  foundationType: nullable(oneOf(FOUNDATIONS)),
  bedrooms: nullable(int(0, 1000)),
  bathrooms: nullable(num(0, 20)),
  lotSize: nullable(str(0, 50)),
  unit: nullable(str(0, 50)),
  county: nullable(str(0, 100)),
  closingDate: nullable(civilDate),
  referenceNumber: nullable(str(0, 64)),
};

const parseCreate = shape(createFields, ['id', 'propertyAddress', 'templateId']);
const parseChanges = shape(updateFields, []);
const parseInspectionRef = shape({ inspectionId: localId }, ['inspectionId']);

function idFrom(payload: Payload, key: string): string | null {
  const value = payload[key];
  return isLocalId(value) ? value : null;
}

export const INSPECTION_CREATE: CommandDef = {
  op: 'inspection.create',
  method: 'POST',
  pathTemplate: '/api/inspections',
  scope: 'inspection',
  idempotency: 'safe_to_repeat',
  neverBlock: true,
  registryVersion: 1,
  createsInspection: true,
  prepare: (input, newId) => (input.id === undefined ? { ...input, id: newId() } : input),
  parse: parseCreate,
  inspectionIdOf: (payload) => idFrom(payload, 'id'),
  body: (payload) => payload,
  sample: { id: 'local-1', propertyAddress: '12 Test Street', templateId: 'template-1' },
};

export const INSPECTION_UPDATE: CommandDef = {
  op: 'inspection.update',
  method: 'PATCH',
  pathTemplate: '/api/inspections/{id}',
  scope: 'inspection',
  idempotency: 'safe_to_repeat',
  neverBlock: true,
  registryVersion: 1,
  parse: (input) => {
    if (!isRecord(input)) return invalid();
    const ref = parseInspectionRef(input);
    const changes = parseChanges(input.changes);
    if (Object.keys(changes).length === 0) return invalid();
    return { inspectionId: ref.inspectionId, changes };
  },
  inspectionIdOf: (payload) => idFrom(payload, 'inspectionId'),
  body: (payload) => payload.changes,
  sample: { inspectionId: 'local-1', changes: { propertyAddress: '14 Test Street' } },
};

export const INSPECTION_COMPLETE: CommandDef = {
  op: 'inspection.complete',
  method: 'POST',
  pathTemplate: '/api/inspections/{id}/complete',
  scope: 'inspection',
  idempotency: 'safe_to_repeat',
  neverBlock: true,
  registryVersion: 1,
  parse: parseInspectionRef,
  inspectionIdOf: (payload) => idFrom(payload, 'inspectionId'),
  body: () => undefined,
  sample: { inspectionId: 'local-1' },
};

export const DEFAULT_REGISTRY: CommandRegistry = [INSPECTION_CREATE, INSPECTION_UPDATE, INSPECTION_COMPLETE];

export function findCommand(registry: CommandRegistry, op: string): CommandDef | null {
  return registry.find((def) => def.op === op) ?? null;
}

/**
 * The inspection id of a validated payload. Fails closed: an inspection-bound op whose payload holds no
 * well-formed id is refused, so no queued row can ever escape the per-inspection checks with a NULL id.
 */
export function requireInspectionId(def: CommandDef, payload: Payload): string | null {
  const id = def.inspectionIdOf(payload);
  if (def.scope === 'inspection') {
    if (id === null) throw new RegistryError('invalid_inspection_id');
    return id;
  }
  return null;
}

export function payloadBytes(payload: Payload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/**
 * Validates `input` for `op` and returns the cleaned payload together with its inspection id.
 * `newId` supplies device-generated ids (`crypto.randomUUID`). Throws `RegistryError`.
 */
export function validateCommand(registry: CommandRegistry, op: string, input: unknown, newId: () => string): { def: CommandDef; payload: Payload; inspectionId: string | null } {
  const def = findCommand(registry, op);
  if (def === null) throw new RegistryError('unknown_op');
  if (!isRecord(input)) throw new RegistryError('invalid_payload');
  const prepared = def.prepare ? def.prepare(input, newId) : input;
  const payload = def.parse(prepared);
  const inspectionId = requireInspectionId(def, payload);
  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES) throw new RegistryError('payload_too_large');
  return { def, payload, inspectionId };
}

/**
 * The route a queued command is replayed to. The inspection id is the validated one substituted into the
 * template; payload text never becomes part of a url.
 */
export function pathFor(def: CommandDef, inspectionId: string | null): string {
  if (!def.pathTemplate.includes('{id}')) return def.pathTemplate;
  if (inspectionId === null || !isLocalId(inspectionId)) throw new RegistryError('invalid_inspection_id');
  return def.pathTemplate.replace('{id}', encodeURIComponent(inspectionId));
}
