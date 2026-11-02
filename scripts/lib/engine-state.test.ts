import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeState } from './engine-state.mjs';

/**
 * G3 asks the fake engine two questions through its control server: "has anything been uploaded yet?" (it must not have, the engine was
 * off while the photo was taken) and "has the photo been uploaded, exactly once?" (after the restart and the engine coming back).
 * The first fixture is a real answer of GET /__test__/state from the emulator run that proved the flow, not an invented one.
 */
const SCRIPT = join(__dirname, 'engine-state.mjs');
const real = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'engine-state-one-upload.json'), 'utf8')) as Record<string, unknown>;
const key = Object.keys(real.completedCounts as Record<string, number>)[0] as string;
const none = { ...real, completedCounts: {}, uploadCounts: {}, uploadKeys: [] };

describe('judgeState', () => {
  it('none-uploaded: passes on a state with no completed upload', () => {
    expect(judgeState(none, 'none-uploaded')).toMatchObject({ ok: true, done: true });
  });
  it('none-uploaded: FAILS when an upload completed (the engine was supposed to be off)', () => {
    const v = judgeState(real, 'none-uploaded');
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain(key);
  });
  it('one-uploaded: passes on the real state of a finished upload', () => {
    expect(judgeState(real, 'one-uploaded')).toMatchObject({ ok: true, done: true });
  });
  it('one-uploaded: not yet is "keep polling", not a failure of the flow', () => {
    expect(judgeState(none, 'one-uploaded')).toMatchObject({ ok: false, done: false });
  });
  it('one-uploaded: the same upload completing twice is a failure that ends the polling', () => {
    const v = judgeState({ ...real, completedCounts: { [key]: 2 } }, 'one-uploaded');
    expect(v).toMatchObject({ ok: false, done: true });
    expect(v.problems.join(' ')).toContain('more than once');
  });
  it('one-uploaded: a second, different upload is a failure', () => {
    expect(judgeState({ ...real, completedCounts: { [key]: 1, other: 1 } }, 'one-uploaded')).toMatchObject({ ok: false, done: true });
  });
  it('an error logged by the engine fails both questions', () => {
    expect(judgeState({ ...none, errors: ['upload body read: boom'] }, 'none-uploaded').ok).toBe(false);
    expect(judgeState({ ...real, errors: ['upload body read: boom'] }, 'one-uploaded').ok).toBe(false);
  });
  it.each([null, 'text', [], { errors: [] }, { completedCounts: {} }, { completedCounts: [], errors: [] }])('a body that is not the fake engine state (%j) is a failure, never "nothing uploaded"', (body) => {
    expect(judgeState(body, 'none-uploaded')).toMatchObject({ ok: false, done: true });
  });
});

describe('the command line', () => {
  let server: Server;
  let origin = '';
  let body: unknown = none;
  let status = 200;
  // When set, the answer for the Nth request onward (counting from 1) is `laterBody`: a state that changes while the check is watching.
  let laterFrom = Infinity;
  let laterBody: unknown = none;
  let requests = 0;
  beforeAll(async () => {
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(requests >= laterFrom ? laterBody : body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));

  // Asynchronous on purpose: the stand-in control server lives in THIS process, and a blocking spawnSync would stop it from answering the child.
  const run = (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  it('exits 0 for none-uploaded on an empty state and 1 on an uploaded one', async () => {
    body = none; status = 200;
    expect((await run(origin, 'none-uploaded')).status).toBe(0);
    body = real;
    const r = await run(origin, 'none-uploaded');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('::error::none-uploaded failed');
  });
  it('one-uploaded exits 0 at once on a finished upload and 1 after the time limit when it never finishes', async () => {
    body = real; status = 200;
    expect((await run(origin, 'one-uploaded', '5', '0')).status).toBe(0);
    body = none;
    const started = Date.now();
    const r = await run(origin, 'one-uploaded', '1');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no upload has completed yet');
    expect(Date.now() - started).toBeLessThan(30000);
  });
  it('one-uploaded keeps watching after the first success: a second copy that arrives inside the settle time fails it (control: the same run without one passes)', async () => {
    body = real; status = 200; requests = 0; laterFrom = Infinity;
    const quiet = await run(origin, 'one-uploaded', '10', '3');
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain('stayed that way for 3 s');
    requests = 0; laterFrom = 2; laterBody = { ...real, completedCounts: { [key]: 2 } };
    const doubled = await run(origin, 'one-uploaded', '10', '30');
    laterFrom = Infinity;
    expect(doubled.status).toBe(1);
    expect(doubled.stderr).toContain('after it had been met');
    expect(doubled.stderr).toContain('more than once');
  });
  it('one-uploaded is not satisfied while an upload is still in flight', async () => {
    body = { ...real, activeUploadCount: 1 }; status = 200; requests = 0; laterFrom = Infinity;
    const r = await run(origin, 'one-uploaded', '1', '0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('still in flight');
  });
  it('a control server that answers an error, or nobody at all, is exit 1 for none-uploaded (a dead engine is not "nothing uploaded")', async () => {
    body = none; status = 500;
    expect((await run(origin, 'none-uploaded')).status).toBe(1);
    expect((await run('http://127.0.0.1:1', 'none-uploaded')).status).toBe(1);
  });
  it('a missing or unknown question is a usage error (exit 2)', async () => {
    expect((await run(origin)).status).toBe(2);
    expect((await run(origin, 'whatever')).status).toBe(2);
  });
});
