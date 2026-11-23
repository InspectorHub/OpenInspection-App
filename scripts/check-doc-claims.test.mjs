import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildSuffixSet, extractClaims, resolveClaims } from './lib/doc-claims.mjs';

const sourceRoot = dirname(fileURLToPath(import.meta.url));

function fixtureRepo(markdown = null, baseline = null) {
    const root = mkdtempSync(join(tmpdir(), 'app-doc-claims-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    cpSync(join(sourceRoot, 'check-doc-claims.mjs'), join(root, 'scripts', 'check-doc-claims.mjs'));
    cpSync(join(sourceRoot, 'lib', 'doc-claims.mjs'), join(root, 'scripts', 'lib', 'doc-claims.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    if (markdown !== null) writeFileSync(join(root, 'README.md'), markdown);
    if (baseline !== null) writeFileSync(join(root, 'scripts', 'doc-claims-baseline.json'), JSON.stringify(baseline));
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    return root;
}

test('extracts repository paths and npm scripts but ignores prose, URLs and fenced examples', () => {
    const text = [
        'See `docs/development.md` and run `npm run test`.',
        '`https://example.com/docs/a.md` `client/server`',
        '```\n`docs/missing.md`\n```',
    ].join('\n');
    assert.deepEqual(extractClaims(text).map(({ kind, value }) => `${kind}:${value}`), [
        'path:docs/development.md', 'npm-script:test',
    ]);
});

test('records source line and npm prefix', () => {
    const [claim] = extractClaims('line one\n`npm --prefix tools run lint`');
    assert.deepEqual([claim.prefix, claim.line], ['tools', 2]);
});

test('resolves tracked path suffixes and real scripts, and reports missing claims', () => {
    const files = ['docs/development.md', 'scripts/check.mjs'];
    const results = resolveClaims(extractClaims('`docs/development.md` `scripts/missing.mjs` `npm run test` `npm run absent`'), {
        repoRoot: 'C:/repo',
        docFile: 'C:/repo/README.md',
        packageScripts: () => new Set(['test']),
        suffixSet: buildSuffixSet(files),
        exists: () => false,
        canonicalize: (path) => resolve(path),
    });
    assert.deepEqual(results.map(({ ok }) => ok), [true, false, true, false]);
});

test('a public repository path cannot resolve outside the repository', () => {
    const [result] = resolveClaims(extractClaims('`../../private/docs/secret.md`'), {
        repoRoot: 'C:/repo', docFile: 'C:/repo/README.md',
        packageScripts: () => null, suffixSet: new Set(), exists: () => true,
    });
    assert.equal(result.ok, false);
});

test('an npm prefix outside the repository cannot resolve an external package script', () => {
    const consulted = [];
    const [result] = resolveClaims(extractClaims('`npm --prefix ../../outside run secret-task`'), {
        repoRoot: 'C:/repo', docFile: 'C:/repo/README.md',
        packageScripts: (dir) => { consulted.push(dir); return new Set(['secret-task']); },
        suffixSet: new Set(),
        canonicalize: (path) => resolve(path),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(consulted, []);
});

test('an in-repository symlink or junction cannot resolve an external package script', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-doc-claims-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'app-doc-claims-outside-'));
    const redirect = join(root, 'redirect');
    const consulted = [];
    const canonicalize = (path) => resolve(path) === resolve(redirect) ? resolve(outside) : resolve(path);
    const [result] = resolveClaims(extractClaims('`npm --prefix redirect run external-task`'), {
        repoRoot: root,
        docFile: join(root, 'README.md'),
        packageScripts: (dir) => { consulted.push(dir); return new Set(['external-task']); },
        suffixSet: new Set(),
        canonicalize,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(consulted, []);
});

test('production realpath containment rejects a real junction to an external package', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'app-doc-claims-junction-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'app-doc-claims-junction-outside-'));
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ scripts: { externalTask: 'node outside.js' } }));
    const junction = join(root, 'redirect');
    try {
        symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
            t.skip(`Windows denied creation of a temporary directory junction (${error.code})`);
            return;
        }
        throw error;
    }

    const consulted = [];
    const [result] = resolveClaims(extractClaims('`npm --prefix redirect run externalTask`'), {
        repoRoot: root,
        docFile: join(root, 'README.md'),
        packageScripts: (dir) => {
            consulted.push(dir);
            const file = join(dir, 'package.json');
            return existsSync(file) ? new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).scripts ?? {})) : null;
        },
        suffixSet: new Set(),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(consulted, []);
});

test('the checker rejects an empty documentation inventory', () => {
    const root = fixtureRepo();
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-doc-claims.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /examined 0 Markdown files/);
});

test('the numeric baseline fails when dead claims rise above its ceiling', () => {
    const root = fixtureRepo('See `docs/missing.md`.\n', { maxDead: 0 });
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-doc-claims.mjs'), '--baseline'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dead claims 1 exceed ceiling 0/);
});

test('the checker rejects a numeric baseline raised above the base revision', () => {
    const root = fixtureRepo('No references here.\n', { maxDead: 0 });
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Docs test', '-c', 'user.email=docs-test@example.invalid', 'commit', '-m', 'seed baseline'], { stdio: 'ignore' });
    writeFileSync(join(root, 'scripts', 'doc-claims-baseline.json'), JSON.stringify({ maxDead: 1 }));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-doc-claims.mjs'), '--baseline', '--against', 'HEAD'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /baseline ceiling 1 exceeds base ceiling 0/);
});
