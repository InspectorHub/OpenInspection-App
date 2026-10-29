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
    log('quit-shutdown-failed');
    Reflect.apply(log, null, ['auth-code=SECRET_TOKEN https://server/?token=SECRET_QUERY', { argv: ['SECRET_ARGV'], error: new Error('SECRET_ERROR') }]);
    const text = readFileSync(join(root, 'logs/main.log'), 'utf8');
    expect(text).toContain('startup');
    expect(text).toContain('quit-shutdown-failed');
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text.trim())).toEqual({ time: expect.any(String), event: 'startup' });
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
