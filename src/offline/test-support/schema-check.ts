/**
 * A small checker for the OpenAPI 3.0 schema subset the native contract uses. It exists so the drift test can
 * ask "does this payload satisfy the server's request schema" without a dependency. A keyword it does not
 * know makes it throw, so a contract that starts using one cannot silently pass.
 */
type Schema = Record<string, unknown>;

export interface Document {
  components: { schemas: Record<string, Schema> };
}

const KNOWN = new Set([
  '$ref',
  'type',
  'nullable',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'properties',
  'required',
  'items',
  'anyOf',
  'allOf',
  'format',
  'description',
  'example',
  'default',
  'additionalProperties',
]);

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(doc: Document, schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  const found = name === undefined ? undefined : doc.components.schemas[name];
  if (!found) throw new Error(`Unresolvable ref ${ref}`);
  return found;
}

/** Returns the list of violations; empty means the value satisfies the schema. */
export function check(doc: Document, schemaIn: Schema, value: unknown, at = '$'): string[] {
  const schema = resolve(doc, schemaIn);
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`Unsupported schema keyword ${key}`);
  if (value === null) return schema.nullable === true || (Array.isArray(schema.enum) && schema.enum.includes(null)) ? [] : [`${at}: null not allowed`];
  const errors: string[] = [];
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) errors.push(...check(doc, part as Schema, value, at));
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as Schema[];
    if (!options.some((option) => check(doc, option, value, at).length === 0)) errors.push(`${at}: matches no anyOf branch`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  const type = schema.type;
  if (type === 'string') {
    if (typeof value !== 'string') return [...errors, `${at}: not a string`];
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${at}: too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern`);
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${at}: email`);
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${at}: date-time`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [...errors, `${at}: not a number`];
    if (type === 'integer' && !Number.isInteger(value)) errors.push(`${at}: not an integer`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${at}: above maximum`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${at}: not a boolean`);
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${at}: not an array`];
    const items = schema.items;
    if (isRecord(items)) value.forEach((entry: unknown, i) => errors.push(...check(doc, items, entry, `${at}[${String(i)}]`)));
  } else if (type === 'object') {
    if (!isRecord(value)) return [...errors, `${at}: not an object`];
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? (schema.required as string[]) : []) if (!(required in value)) errors.push(`${at}.${required}: required`);
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (isRecord(property)) errors.push(...check(doc, property, entry, `${at}.${key}`));
    }
  }
  return errors;
}
