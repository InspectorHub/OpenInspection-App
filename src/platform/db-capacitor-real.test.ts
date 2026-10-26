import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  upgrades: [] as { toVersion: number; statements: string[] }[],
  createdVersion: -1,
  userVersion: 0,
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));

vi.mock('@capacitor-community/sqlite', () => {
  const conn = {
    open: () => Promise.resolve(),
    query: () => Promise.resolve({ values: [{ user_version: fake.userVersion }] }),
  };
  class SQLiteConnection {
    isSecretStored() {
      return Promise.resolve({ result: true });
    }
    checkConnectionsConsistency() {
      return Promise.resolve({ result: true });
    }
    addUpgradeStatement(_name: string, upgrades: { toVersion: number; statements: string[] }[]) {
      fake.upgrades = upgrades;
      return Promise.resolve();
    }
    isConnection() {
      return Promise.resolve({ result: false });
    }
    createConnection(_name: string, _enc: boolean, _mode: string, version: number) {
      fake.createdVersion = version;
      return Promise.resolve(conn);
    }
    closeConnection(name: string) {
      fake.calls.push(`closeConnection:${name}`);
      return Promise.resolve();
    }
  }
  return { CapacitorSQLite: {}, SQLiteConnection };
});

import { openRealCapacitorDb } from './db-capacitor';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, SchemaTooNewError, toUpgradeStatements } from './schema';

beforeEach(() => {
  fake.calls = [];
  fake.upgrades = [];
  fake.createdVersion = -1;
  fake.userVersion = 0;
});

describe('openRealCapacitorDb', () => {
  it('defaults to the current schema version and the real migrations', async () => {
    await openRealCapacitorDb({ name: 'oi' });
    expect(fake.createdVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(fake.upgrades).toEqual(toUpgradeStatements(MIGRATIONS));
  });

  it('refuses a database written by a newer schema', async () => {
    fake.userVersion = CURRENT_SCHEMA_VERSION + 1;
    await expect(openRealCapacitorDb({ name: 'oi' })).rejects.toThrow(SchemaTooNewError);
    expect(fake.calls).toContain('closeConnection:oi');
  });
});
