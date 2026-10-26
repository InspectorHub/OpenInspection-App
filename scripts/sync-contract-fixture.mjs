// Writes the slice of the engine's native contract that the offline command registry replays to, as a
// committed test fixture: src/offline/test-support/native-contract.snapshot.json.
//
//   OPENINSPECTION_CONTRACT=<path> npm run contract:fixture
//   npm run contract:fixture -- <path>
//
// The drift test (src/offline/registry.test.ts) reads the fixture and fails when a registered command's
// method, route or payload no longer matches. Add a route here when a command for it is registered.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ROUTES = [
  ['/api/inspections', 'post'],
  ['/api/inspections/{id}', 'patch'],
  ['/api/inspections/{id}/complete', 'post'],
];

const source = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.OPENINSPECTION_CONTRACT;
if (!source) {
  console.error('Set OPENINSPECTION_CONTRACT or pass the contract path as an argument.');
  process.exit(2);
}

const raw = readFileSync(source);
const contract = JSON.parse(raw.toString('utf8'));

const schemas = {};
const pending = [];
function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value);
      if (!match) throw new Error(`Unsupported $ref ${value}`);
      if (!(match[1] in schemas)) pending.push(match[1]);
      schemas[match[1]] ??= null;
    } else collect(value);
  }
}

const paths = {};
for (const [route, method] of ROUTES) {
  const operation = contract.paths?.[route]?.[method];
  if (!operation) {
    console.error(`The contract has no ${method.toUpperCase()} ${route}.`);
    process.exit(1);
  }
  const slim = {
    operationId: operation.operationId,
    ...(operation.parameters ? { parameters: operation.parameters } : {}),
    ...(operation.requestBody ? { requestBody: operation.requestBody } : {}),
    responses: Object.fromEntries(Object.keys(operation.responses ?? {}).map((status) => [status, { description: operation.responses[status].description ?? '' }])),
  };
  collect(slim);
  (paths[route] ??= {})[method] = slim;
}
while (pending.length > 0) {
  const name = pending.pop();
  const schema = contract.components?.schemas?.[name];
  if (!schema) throw new Error(`The contract has no schema ${name}.`);
  schemas[name] = schema;
  collect(schema);
}

const sortedSchemas = Object.fromEntries(Object.keys(schemas).sort().map((name) => [name, schemas[name]]));
const fixture = {
  openapi: contract.openapi,
  info: { title: contract.info?.title ?? '', version: contract.info?.version ?? '', 'x-source-sha256': createHash('sha256').update(raw).digest('hex') },
  paths,
  components: { schemas: sortedSchemas },
};
const target = 'src/offline/test-support/native-contract.snapshot.json';
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${target} (${Object.keys(paths).length} routes, ${Object.keys(sortedSchemas).length} schemas).`);
