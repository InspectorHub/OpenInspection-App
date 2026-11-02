// Fails fast when the iOS release job is missing something it needs, before any certificate is imported.
//
//   node scripts/ios-release-preflight.mjs      reads process.env; prints one ::error:: line per problem and exits 1
//
// Without it, an environment that has no secrets configured fails inside the certificate-import action with an unrelated message.
// An unset environment secret reaches a step as an empty string, so empty counts as missing here.
//
// It checks the shape of each value only (present, no stray whitespace, the certificate is base64 of a DER structure, the API key
// is a PEM private key). It does not know any Apple rule and it cannot tell whether a value is correct. A problem names the
// variable and the reason; it never contains the value, because the output of this script lands in a build log.
import { pathToFileURL } from 'node:url';

export const REQUIRED = [
  'IOS_DISTRIBUTION_CERT_P12_BASE64',
  'IOS_DISTRIBUTION_CERT_PASSWORD',
  'APPSTORE_API_PRIVATE_KEY',
  'APPSTORE_ISSUER_ID',
  'APPSTORE_API_KEY_ID',
  'APPLE_TEAM_ID',
];

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DER_SEQUENCE = 0x30;
// A .p8 file ends with a line break, and pasting it keeps that break, so the private key may end with one.
const TRAILING_BREAK = /\r?\n$/;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkIosReleaseEnv(env) {
  const problems = [];
  for (const name of REQUIRED) {
    const value = env[name];
    if (value === undefined || value === '') {
      problems.push(`${name} is not set or is empty`);
      continue;
    }
    const checked = name === 'APPSTORE_API_PRIVATE_KEY' ? value.replace(TRAILING_BREAK, '') : value;
    if (checked !== checked.trim()) {
      problems.push(`${name} has leading or trailing whitespace`);
      continue;
    }
    if (checked === '') {
      problems.push(`${name} is not set or is empty`);
      continue;
    }
    if (name === 'IOS_DISTRIBUTION_CERT_P12_BASE64') {
      if (!BASE64.test(value) || value.length % 4 !== 0) {
        problems.push(`${name} is not a single line of base64`);
      } else if (Buffer.from(value, 'base64')[0] !== DER_SEQUENCE) {
        problems.push(`${name} does not decode to a DER structure (first byte is not 0x30), so it is not a .p12 file`);
      }
    }
    if (name === 'APPSTORE_API_PRIVATE_KEY' && !checked.includes('BEGIN PRIVATE KEY')) {
      problems.push(`${name} does not contain a PEM private key (no BEGIN PRIVATE KEY line)`);
    }
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, problems } = checkIosReleaseEnv(process.env);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (!ok) {
    console.log('Configure the missing items in the ios-release environment (docs/release.md, "What the owner configures in GitHub").');
    process.exit(1);
  }
  console.log(`ok: all ${REQUIRED.length} iOS release secrets and variables are present and have the expected shape`);
}
