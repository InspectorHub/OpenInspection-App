import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'ios-release-preflight.mjs');

type Env = Record<string, string | undefined>;
interface Check {
  ok: boolean;
  problems: string[];
}
const { checkIosReleaseEnv } = (await import(pathToFileURL(SCRIPT).href)) as { checkIosReleaseEnv: (env: Env) => Check };

const NAMES = [
  'IOS_DISTRIBUTION_CERT_P12_BASE64',
  'IOS_DISTRIBUTION_CERT_PASSWORD',
  'APPSTORE_API_PRIVATE_KEY',
  'APPSTORE_ISSUER_ID',
  'APPSTORE_API_KEY_ID',
  'APPLE_TEAM_ID',
] as const;

// A DER SEQUENCE starts with 0x30; a PKCS12 file is one. These bytes only have the right first byte, they are not a real certificate.
const P12 = Buffer.from([0x30, 0x82, 0x01, 0x00, 0x02, 0x01, 0x03]).toString('base64');
const PEM = ['-----BEGIN PRIVATE KEY-----', 'AAAA', '-----END PRIVATE KEY-----'].join('\n');
const complete = (): Env => ({
  IOS_DISTRIBUTION_CERT_P12_BASE64: P12,
  IOS_DISTRIBUTION_CERT_PASSWORD: 'a-password',
  APPSTORE_API_PRIVATE_KEY: PEM,
  APPSTORE_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
  APPSTORE_API_KEY_ID: 'ABC123DEFG',
  APPLE_TEAM_ID: 'ABCDE12345',
});
const without = (name: string, value?: string): Env => ({ ...complete(), [name]: value });
const mentions = (problems: string[], name: string): boolean => problems.some((p) => p.includes(name));

describe('the iOS release preflight', () => {
  it('accepts a complete environment (control: the failures below are not caused by the fixture)', () => {
    expect(checkIosReleaseEnv(complete())).toEqual({ ok: true, problems: [] });
  });

  it.each(NAMES)('names exactly %s when only that one is missing', (name) => {
    const result = checkIosReleaseEnv(without(name));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(mentions(result.problems, name)).toBe(true);
    for (const other of NAMES.filter((n) => n !== name)) expect(mentions(result.problems, other), other).toBe(false);
  });

  it.each(NAMES)('treats an empty %s the same as an undefined one (an unset environment secret arrives as an empty string)', (name) => {
    expect(checkIosReleaseEnv(without(name, ''))).toEqual(checkIosReleaseEnv(without(name, undefined)));
    expect(checkIosReleaseEnv(without(name, '')).ok).toBe(false);
  });

  it('names every missing one when the whole environment is empty', () => {
    const result = checkIosReleaseEnv({});
    expect(result.ok).toBe(false);
    for (const name of NAMES) expect(mentions(result.problems, name), name).toBe(true);
  });

  it('rejects a certificate that is not base64, and one whose first byte is not 0x30', () => {
    const notBase64 = checkIosReleaseEnv(without('IOS_DISTRIBUTION_CERT_P12_BASE64', 'this is not base64!'));
    expect(notBase64.ok).toBe(false);
    expect(notBase64.problems).toHaveLength(1);
    expect(mentions(notBase64.problems, 'IOS_DISTRIBUTION_CERT_P12_BASE64')).toBe(true);
    const wrongByte = checkIosReleaseEnv(without('IOS_DISTRIBUTION_CERT_P12_BASE64', Buffer.from([0x31, 0x82, 0x01]).toString('base64')));
    expect(wrongByte.ok).toBe(false);
    expect(wrongByte.problems).toHaveLength(1);
    expect(mentions(wrongByte.problems, 'IOS_DISTRIBUTION_CERT_P12_BASE64')).toBe(true);
    // control: the same shape with the right first byte passes
    expect(checkIosReleaseEnv(without('IOS_DISTRIBUTION_CERT_P12_BASE64', Buffer.from([0x30, 0x82, 0x01]).toString('base64'))).ok).toBe(true);
  });

  it('rejects an API key that is not a PEM private key', () => {
    const result = checkIosReleaseEnv(without('APPSTORE_API_PRIVATE_KEY', 'AuthKey_ABC123DEFG.p8'));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(mentions(result.problems, 'APPSTORE_API_PRIVATE_KEY')).toBe(true);
  });

  it('rejects leading and trailing whitespace, but allows the final line break a pasted PEM file ends with', () => {
    for (const name of NAMES.filter((n) => n !== 'APPSTORE_API_PRIVATE_KEY')) {
      for (const padded of [` ${complete()[name] ?? ''}`, `${complete()[name] ?? ''} `, `${complete()[name] ?? ''}\n`]) {
        const result = checkIosReleaseEnv(without(name, padded));
        expect(result.ok, `${name} ${JSON.stringify(padded)}`).toBe(false);
        expect(mentions(result.problems, name)).toBe(true);
      }
    }
    expect(checkIosReleaseEnv(without('APPSTORE_API_PRIVATE_KEY', ` ${PEM}`)).ok).toBe(false);
    // control
    expect(checkIosReleaseEnv(without('APPSTORE_API_PRIVATE_KEY', `${PEM}\n`)).ok).toBe(true);
  });

  it('never puts a value in a problem', () => {
    const marker = 'SECRETMARKER9f3a';
    const encoded = Buffer.from(marker).toString('base64');
    const bad: Env = {
      // base64 that decodes to a wrong first byte, so the decoded text contains the marker
      IOS_DISTRIBUTION_CERT_P12_BASE64: encoded,
      IOS_DISTRIBUTION_CERT_PASSWORD: ` ${marker}`,
      APPSTORE_API_PRIVATE_KEY: marker,
      APPSTORE_ISSUER_ID: `${marker} `,
      APPSTORE_API_KEY_ID: `\t${marker}`,
      APPLE_TEAM_ID: `${marker}\n`,
    };
    const result = checkIosReleaseEnv(bad);
    // control: every variable was rejected, so the assertions below looked at six reasons
    expect(result.ok).toBe(false);
    for (const name of NAMES) expect(mentions(result.problems, name), name).toBe(true);
    const text = JSON.stringify(result.problems);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(encoded);
    // and a differently-broken base64 value
    const garbage = checkIosReleaseEnv(without('IOS_DISTRIBUTION_CERT_P12_BASE64', `${marker}!!`));
    expect(garbage.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(garbage.problems)).not.toContain(marker);
  });
});

describe('the iOS release preflight as a command', () => {
  const run = (env: Env) => {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
    return spawnSync(process.execPath, [SCRIPT], { env: clean, encoding: 'utf8' });
  };

  it('exits 0 and prints no error for a complete environment', () => {
    const result = run(complete());
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('::error::');
  });

  it('exits 1 and prints one ::error:: line per problem, naming the variable and never its value', () => {
    const marker = 'SECRETMARKER9f3a';
    const result = run({ ...complete(), APPSTORE_API_PRIVATE_KEY: marker, APPLE_TEAM_ID: '' });
    expect(result.status).toBe(1);
    const lines = result.stdout.split('\n').filter((l) => l.startsWith('::error::'));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('APPSTORE_API_PRIVATE_KEY'))).toBe(true);
    expect(lines.some((l) => l.includes('APPLE_TEAM_ID'))).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(marker);
  });
});
