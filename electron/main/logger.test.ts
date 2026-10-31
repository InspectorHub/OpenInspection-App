import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLogger } from './logger.ts';

it('writes only closed safe event categories without secret-bearing fields or exceptions', () => {
  const root = mkdtempSync(join(tmpdir(), 'oi-log-'));
  try {
    const log = createLogger(root);
    log('startup');
    log('window-ready');
    log('quit-shutdown-failed');
    Reflect.apply(log, null, ['auth-code=SECRET_TOKEN https://server/?token=SECRET_QUERY', { argv: ['SECRET_ARGV'], error: new Error('SECRET_ERROR') }]);
    const text = readFileSync(join(root, 'logs/main.log'), 'utf8');
    expect(text).toContain('startup');
    expect(text).toContain('window-ready');
    expect(text).toContain('quit-shutdown-failed');
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text.trim().split(/\r?\n/)[0]!)).toEqual({ time: expect.any(String), event: 'startup' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('rotates at 1 MiB and keeps exactly three files', () => {
  const root = mkdtempSync(join(tmpdir(), 'oi-log-'));
  try {
    const log = createLogger(root);
    log('startup');
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, 'logs/main.log'), 'x'.repeat(1024 * 1024 - 1));
      log('startup');
    }
    expect(readdirSync(join(root, 'logs')).sort()).toEqual(['main.log', 'main.log.1', 'main.log.2']);
    for (const file of readdirSync(join(root, 'logs'))) expect(statSync(join(root, 'logs', file)).size).toBeLessThanOrEqual(1024 * 1024);
    expect(readFileSync(join(root, 'logs/main.log'), 'utf8')).toContain('startup');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('contains disk errors instead of throwing secret exception contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'oi-log-'));
  try {
    writeFileSync(join(root, 'blocked'), 'x');
    expect(() => createLogger(join(root, 'blocked'))('startup')).not.toThrow();
    createLogger(root)('startup');
    expect(readFileSync(join(root, 'logs/main.log'), 'utf8')).toContain('startup');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Every `.ts` file under electron/main that is not a test. */
function sourceFiles(): string[] {
  const root = join(__dirname);
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => join(root, name));
}

it('lets every literal code a call site passes reach the log', () => {
  const codes = new Set<string>();
  // Every quoted string inside a `log(...)` call, so a ternary between two codes counts both.
  for (const file of sourceFiles()) for (const call of readFileSync(file, 'utf8').matchAll(/\blog\(([^;]*)/g)) for (const literal of call[1]!.matchAll(/'([^']+)'/g)) codes.add(literal[1]!);
  // The positive control: the scan really found the call sites it is meant to guard.
  expect(codes.size).toBe(15);
  expect(codes).toContain('db-corrupt');
  expect(codes).toContain('helper-crash');
  const root = mkdtempSync(join(tmpdir(), 'oi-log-'));
  try {
    const log = createLogger(root);
    for (const code of codes) Reflect.apply(log, null, [code]);
    const written = readFileSync(join(root, 'logs/main.log'), 'utf8').trim().split(/\r?\n/).map((line) => (JSON.parse(line) as { event: string }).event);
    expect(written.sort()).toEqual([...codes].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('lets the IPC registry and updater codes through, and nothing outside their closed forms', () => {
  const root = mkdtempSync(join(tmpdir(), 'oi-log-'));
  try {
    const log = createLogger(root);
    const accepted = ['db:open internal', 'uploader:start untrusted-sender', 'files:write disk-full', 'updater-network', 'updater-verify', 'updater-other'];
    const refused = ['nope:channel internal', 'db:open some-free-form-text', 'db:open internal extra', 'updater-https://server/?token=SECRET'];
    for (const code of [...accepted, ...refused]) Reflect.apply(log, null, [code]);
    const written = readFileSync(join(root, 'logs/main.log'), 'utf8').trim().split(/\r?\n/).map((line) => (JSON.parse(line) as { event: string }).event);
    expect(written).toEqual(accepted);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
