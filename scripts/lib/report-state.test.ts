import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module with JSDoc types, no declaration file
import { judgeReport } from './report-state.mjs';

const judge = (state: unknown, expected: { state: string; version: number | null; publishes?: unknown[] }): { ok: boolean; problems: string[] } => judgeReport(state, expected) as { ok: boolean; problems: string[] };

describe('judging where the report stands', () => {
  const locked = { report: { state: 'locked', version: 3 }, publishes: [], errors: [] };

  it('passes when the state and the version match, and a list is only compared when one is asked for', () => {
    expect(judge(locked, { state: 'locked', version: 3 })).toEqual({ ok: true, problems: [] });
    expect(judge(locked, { state: 'locked', version: 3, publishes: [] })).toEqual({ ok: true, problems: [] });
  });

  it('fails on the wrong state, the wrong version, or a wrong list, naming each', () => {
    expect(judge(locked, { state: 'editing', version: 3 }).problems).toEqual(['the report is locked, expected editing']);
    expect(judge(locked, { state: 'locked', version: 4 }).problems).toEqual(['the report is at version 3, expected 4']);
    const seen = { ...locked, publishes: [{ notifyClient: true, summary: 'x', outcome: 'new_version' }] };
    expect(judge(seen, { state: 'locked', version: 3, publishes: [{ notifyClient: false, summary: 'x', outcome: 'new_version' }] }).ok).toBe(false);
    expect(judge(seen, { state: 'locked', version: 3, publishes: [{ notifyClient: true, summary: 'x', outcome: 'new_version' }] }).ok).toBe(true);
  });

  it('a draft has no version, and the expectation says so', () => {
    expect(judge({ report: { state: 'draft', version: null }, publishes: [] }, { state: 'draft', version: null }).ok).toBe(true);
    expect(judge({ report: { state: 'draft', version: null }, publishes: [] }, { state: 'draft', version: 1 }).ok).toBe(false);
  });

  it('is not fooled by something that is not the fake engine, and reports engine errors', () => {
    expect(judge(null, { state: 'locked', version: 3 }).ok).toBe(false);
    expect(judge({}, { state: 'locked', version: 3 }).problems[0]).toContain('has no report');
    expect(judge({ ...locked, errors: ['boom'] }, { state: 'locked', version: 3 }).problems).toEqual(['the engine logged errors: boom']);
    expect(judge({ report: locked.report, errors: [] }, { state: 'locked', version: 3, publishes: [] }).problems).toEqual(['the state has no publishes list']);
  });
});

describe('the script', () => {
  let server: Server;
  let control = '';
  let body: unknown = { report: { state: 'editing', version: 3 }, publishes: [], errors: [] };
  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    control = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = (...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, 'report-state.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('close', (code) => resolve({ code, out }));
  });

  it('exits 0 when the report is as expected', async () => {
    expect((await run(control, 'editing', '3', '[]', '2')).code).toBe(0);
  });

  it('exits 1 with the reason when it is not, within the time given', async () => {
    const result = await run(control, 'locked', '3', '', '1');
    expect(result.code).toBe(1);
    expect(result.out).toContain('the report is editing, expected locked');
  });

  it('exits 1 when the control server cannot be read, and 2 on a bad call', async () => {
    expect((await run('http://127.0.0.1:1', 'locked', '3', '', '1')).code).toBe(1);
    expect((await run(control, 'published', '3')).code).toBe(2);
    expect((await run(control, 'locked', '3', 'not json')).code).toBe(2);
  });
});
