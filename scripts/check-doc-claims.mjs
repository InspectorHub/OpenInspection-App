#!/usr/bin/env node
/** Fail when Markdown cites missing repository paths or npm scripts. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSuffixSet, extractClaims, resolveClaims } from './lib/doc-claims.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE = join(ROOT, 'scripts/doc-claims-baseline.json');

function trackedFiles() {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function packageScripts(dir) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) return null;
    try { return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).scripts ?? {})); }
    catch { return null; }
}

function baselineAt(revision) {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${revision}^{commit}`], { stdio: 'ignore' });
    let raw;
    try {
        raw = execFileSync('git', ['-C', ROOT, 'show', `${revision}:scripts/doc-claims-baseline.json`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return null;
    }
    return JSON.parse(raw);
}

function main() {
    const files = trackedFiles();
    const docs = files.filter((file) => file.toLowerCase().endsWith('.md'));
    const suffixSet = buildSuffixSet(files);
    const dead = [];
    let claimsChecked = 0;
    for (const file of docs) {
        const absolute = join(ROOT, file);
        const claims = extractClaims(readFileSync(absolute, 'utf8'));
        claimsChecked += claims.length;
        for (const result of resolveClaims(claims, {
            repoRoot: ROOT,
            docFile: absolute,
            packageScripts,
            suffixSet,
        })) {
            if (!result.ok) dead.push({ file, ...result.claim });
        }
    }

    console.log(`docs=${docs.length} claims=${claimsChecked} dead=${dead.length}`);
    for (const item of dead) console.log(`${item.file}:${item.line}\t${item.kind}\t${item.value}`);
    if (docs.length === 0) {
        console.error('check-doc-claims: examined 0 Markdown files');
        process.exitCode = 1;
        return;
    }
    if (process.argv.includes('--baseline')) {
        if (!existsSync(BASELINE)) {
            console.error('check-doc-claims: missing scripts/doc-claims-baseline.json');
            process.exitCode = 1;
            return;
        }
        const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
        if (!Number.isInteger(baseline.maxDead) || baseline.maxDead < 0 || dead.length > baseline.maxDead) {
            console.error(`check-doc-claims: dead claims ${dead.length} exceed ceiling ${baseline.maxDead ?? 'n/a'}`);
            process.exitCode = 1;
        }

        const args = process.argv.slice(2);
        const againstFlag = args.indexOf('--against');
        const baseSha = process.env.DOC_CLAIMS_BASE_SHA ?? (againstFlag >= 0 ? args[againstFlag + 1] : null);
        if (baseSha) {
            const previous = baselineAt(baseSha);
            // This is the first baseline commit. App's initial ceiling is zero; a new baseline
            // cannot introduce tolerance that was not present before the checker existed.
            const previousMax = previous === null ? 0 : previous.maxDead;
            if (!Number.isInteger(previousMax) || previousMax < 0) {
                console.error(`check-doc-claims: invalid base ceiling at ${baseSha}`);
                process.exitCode = 1;
            } else if (baseline.maxDead > previousMax) {
                console.error(`check-doc-claims: baseline ceiling ${baseline.maxDead} exceeds base ceiling ${previousMax}`);
                process.exitCode = 1;
            }
        }
    }
}

main();
