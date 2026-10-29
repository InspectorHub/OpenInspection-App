import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openNativeSqlite } from './db-open.ts';
import { createDbHost } from './db-host.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

describe('createDbHost', () => {
  it('rejects a nested begin instead of stealing the open transaction', () => {
    const host = createDbHost(openNativeSqlite(':memory:'));
    host.begin();
    expect(() => host.begin()).toThrow('transaction-already-open');
    host.rollback(); host.close();
  });
});
