import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Maestro flows in `maestro/` run only on an emulator, by hand, so nothing else would notice a flow naming a button the app
 * no longer has. This test reads them as text: each flow must have the shape Maestro expects, every piece of text it taps or
 * waits for must exist in the app's own source (or be one of the engine's login strings, listed below), and none may carry a
 * credential. It does not run Maestro.
 */

const ROOT = join(import.meta.dirname, '..');
const FLOW_DIR = join(ROOT, 'maestro');

/** Strings of the engine's own sign-in and authorize pages. They live in the engine repository, not in this one. */
const ENGINE_OWNED = new Set(['Email address', 'Password', 'Log In', 'Allow']);

const COMMANDS = new Set([
  'launchApp',
  'stopApp',
  'tapOn',
  'inputText',
  'eraseText',
  'hideKeyboard',
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'scrollUntilVisible',
  'runFlow',
  'setAirplaneMode',
  'swipe',
  'waitForAnimationToEnd',
]);

const ENV_REFERENCE = /^"\$\{[A-Z][A-Z0-9_]*\}"$/;

function flowFiles(): string[] {
  return readdirSync(FLOW_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
}

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function appSource(): string {
  return sourceFiles(join(ROOT, 'src'), [])
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .replaceAll('&apos;', "'");
}

interface Parsed {
  appId: string;
  body: string[];
}

/** Splits a flow into its header and its commands and reports every structural problem found, one line each. */
function inspect(text: string): { parsed: Parsed | null; problems: string[] } {
  const problems: string[] = [];
  if (text.includes('\t')) problems.push('contains a tab');
  const lines = text.split('\n');
  const divider = lines.indexOf('---');
  if (divider < 0) return { parsed: null, problems: [...problems, 'has no --- line between the header and the commands'] };
  if (lines.indexOf('---', divider + 1) >= 0) problems.push('has more than one --- line');
  const header = lines.slice(0, divider).filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const appLine = header.find((line) => line.startsWith('appId: '));
  if (header.length !== 1 || appLine === undefined) problems.push('the header must hold exactly one line, appId');
  const body = lines.slice(divider + 1).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (body.length === 0) problems.push('has no commands');
  for (const line of body) {
    if (/^\S/.test(line)) {
      const match = /^- ([A-Za-z]+)(:.*)?$/.exec(line);
      if (match === null) problems.push(`not a command line: ${line}`);
      else if (!COMMANDS.has(match[1] ?? '')) problems.push(`unknown command ${match[1] ?? ''}`);
    } else if (!/^ {2,}\S/.test(line)) {
      problems.push(`bad indentation: ${line}`);
    }
    if ((line.match(/"/g) ?? []).length % 2 !== 0) problems.push(`unbalanced quote: ${line}`);
  }
  return { parsed: { appId: (appLine ?? '').slice('appId: '.length).trim(), body }, problems };
}

/** The double-quoted strings a flow uses as selectors: everything quoted except the text typed into a field. */
function selectors(body: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of body) {
    if (/^\s*-?\s*inputText:/.test(line)) continue;
    // A tap by screen position (point: "50%,78%") names no text.
    if (/^\s*point:/.test(line)) continue;
    for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) found.push(match[1] ?? '');
  }
  return found;
}

/** The literal pieces of a selector, which Maestro matches as a regular expression. */
function fragments(selector: string): string[] {
  return selector
    .split(/\.\*|\\.|[.+?*()[\]|^$]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 3);
}

function missingFromApp(flow: string, source: string): string[] {
  const { parsed } = inspect(flow);
  if (parsed === null) return ['(flow does not parse)'];
  const missing: string[] = [];
  for (const selector of selectors(parsed.body)) {
    if (ENGINE_OWNED.has(selector)) continue;
    const pieces = fragments(selector);
    if (pieces.length === 0) missing.push(`${selector} (no literal text to check)`);
    for (const piece of pieces) if (!source.includes(piece)) missing.push(`${selector} -> ${piece}`);
  }
  return missing;
}

function credentialProblems(flow: string): string[] {
  const problems: string[] = [];
  for (const line of flow.split('\n')) {
    const typed = /^\s*-?\s*inputText:\s*(.*)$/.exec(line);
    if (typed !== null && !ENV_REFERENCE.test((typed[1] ?? '').trim())) problems.push(`inputText is not an environment reference: ${line}`);
    if (/(password|passwd|secret|token|apikey)\s*[:=]\s*["']?[^$"'\s]/i.test(line) && !line.trimStart().startsWith('#')) problems.push(`looks like a credential: ${line}`);
  }
  return problems;
}

describe('the Maestro flows', () => {
  const files = flowFiles();
  const flows = new Map(files.map((name) => [name, readFileSync(join(FLOW_DIR, name), 'utf8')]));
  const source = appSource();

  it('finds the flows and the app source (the checks below are not vacuous)', () => {
    expect(files).toEqual(['01-sign-in.yaml', '02-seed-and-needs-attention.yaml', '03-settings-photos-not-attached.yaml', '04-lock-two-step-clear.yaml']);
    expect(source.length).toBeGreaterThan(100_000);
  });

  it('every flow has the shape Maestro expects and targets the app id of capacitor.config.ts', () => {
    const config = readFileSync(join(ROOT, 'capacitor.config.ts'), 'utf8');
    const appId = /appId:\s*'([^']+)'/.exec(config)?.[1];
    expect(appId).toBe('io.inspectorhub.app');
    for (const [name, text] of flows) {
      const { parsed, problems } = inspect(text);
      expect({ name, problems }).toEqual({ name, problems: [] });
      expect(parsed?.appId, name).toBe(appId);
    }
  });

  it('every text a flow taps or waits for exists in the app source or is one of the engine login strings', () => {
    for (const [name, text] of flows) expect({ name, missing: missingFromApp(text, source) }).toEqual({ name, missing: [] });
  });

  it('the checker catches a renamed selector (positive control) and passes the original (negative control)', () => {
    const original = flows.get('02-seed-and-needs-attention.yaml') ?? '';
    expect(original).toContain('"Diagnostics (development only)"');
    expect(missingFromApp(original, source)).toEqual([]);
    const renamed = original.replace('"Diagnostics (development only)"', '"Diagnostics (testing only)"');
    expect(missingFromApp(renamed, source).length).toBeGreaterThan(0);
    const unknownCommand = original.replace('- stopApp', '- stopTheApp');
    expect(inspect(unknownCommand).problems).toContain('unknown command stopTheApp');
  });

  it('no flow holds a credential: typed text is an environment reference only', () => {
    for (const [name, text] of flows) expect({ name, problems: credentialProblems(text) }).toEqual({ name, problems: [] });
    const signIn = flows.get('01-sign-in.yaml') ?? '';
    expect(signIn).toContain('${E2E_PASSWORD}');
    expect(credentialProblems(signIn.replace('"${E2E_PASSWORD}"', '"hunter2hunter2"')).length).toBeGreaterThan(0);
    expect(credentialProblems(`${signIn}\n- tapOn: "ok"\npassword: abc`).length).toBeGreaterThan(0);
  });

  it('the runner script runs exactly these flows, in order, and takes the account from the environment', () => {
    const runner = readFileSync(join(FLOW_DIR, 'run-emulator.ps1'), 'utf8');
    const named = [...runner.matchAll(/Invoke-Flow '([^']+)'/g)].map((match) => match[1]);
    expect(named).toEqual(files);
    expect(runner).toContain('$env:OI_E2E_PASSWORD');
    expect(runner).not.toMatch(/OI_E2E_(PASSWORD|EMAIL)\s*=\s*['"][^'"<$]/);
  });
});
