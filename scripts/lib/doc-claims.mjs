/**
 * Extract and resolve repository path and npm script claims from Markdown.
 * Keep this small repository-local copy in sync with the InspectorHub
 * superproject's documentation claim checker. Public documentation resolves
 * against this repository only.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const KNOWN_ROOTS = /^(?:\.?[A-Za-z0-9_-]+\/)*(?:docs|apps|scripts|server|app|packages|tests|\.githooks|\.github|migrations|workers|public)\//;
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/;
const PATHISH = /^[\w.@/-]+$/;
const UNTRACKED_ROOTS = /^(?:node_modules|dist(?:-[^/]+)?|build|coverage|test-results|playwright-report|\.wrangler|\.types)\//;
const NPM = /^npm\s+(?:--prefix[ =](\S+)\s+)?run\s+([A-Za-z0-9:_.-]+)/;

function canonicalizeWithMissingPath(candidate) {
    let probe = resolve(candidate);
    const suffix = [];
    while (true) {
        try {
            return resolve(realpathSync(probe), ...suffix);
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
            const parent = dirname(probe);
            if (parent === probe) return null;
            suffix.unshift(basename(probe));
            probe = parent;
        }
    }
}

function isInsideRepo(repoRoot, target, canonicalize) {
    const realRoot = canonicalize(repoRoot);
    const realTarget = canonicalize(target);
    if (!realRoot || !realTarget) return false;
    const rel = relative(realRoot, realTarget);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export function extractClaims(text) {
    const claims = [];
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
        if (inFence) return;
        for (const match of line.matchAll(/`([^`\n]+)`/g)) {
            const token = match[1].trim();
            const npm = token.match(NPM);
            if (npm) {
                claims.push({ kind: 'npm-script', value: npm[2], prefix: npm[1] ?? null, line: i + 1 });
                continue;
            }
            if (token.includes('://') || token.startsWith('/') || token.startsWith('~') || token.startsWith('@')) continue;
            if (/[ *<>{}$|\s]/.test(token)) continue;
            const value = token.replace(/:\d+(?:-\d+)?$/, '').replace(/#[\w-]+$/, '');
            if (/^(?:\.[A-Za-z0-9]+\/?)+$/.test(value)) continue;
            if (!value.includes('/') || !PATHISH.test(value) || UNTRACKED_ROOTS.test(value)) continue;
            if (!(KNOWN_ROOTS.test(value) || HAS_EXT.test(value))) continue;
            claims.push({ kind: 'path', value, prefix: null, line: i + 1 });
        }
    });
    return claims;
}

export function buildSuffixSet(trackedFiles) {
    const set = new Set();
    for (const file of trackedFiles) {
        const segments = file.split('/');
        for (let i = 0; i < segments.length; i++) {
            set.add(segments.slice(i).join('/'));
            for (let j = i + 1; j < segments.length; j++) set.add(`${segments.slice(i, j).join('/')}/`);
        }
    }
    return set;
}

export function resolveClaims(claims, { repoRoot, docFile, packageScripts, suffixSet, exists = existsSync, canonicalize = canonicalizeWithMissingPath }) {
    return claims.map((claim) => {
        if (claim.kind === 'path') {
            const insideRepo = (base) => {
                const target = resolve(base, claim.value);
                return isInsideRepo(repoRoot, target, canonicalize) && exists(target);
            };
            const ok = insideRepo(repoRoot) || insideRepo(resolve(docFile, '..')) || suffixSet.has(claim.value);
            return { claim, ok };
        }
        const packageRoot = claim.prefix ? resolve(repoRoot, claim.prefix) : repoRoot;
        if (!isInsideRepo(repoRoot, packageRoot, canonicalize)) {
            return { claim, ok: false };
        }
        return { claim, ok: packageScripts(packageRoot)?.has(claim.value) ?? false };
    });
}
