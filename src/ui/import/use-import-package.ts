import { extractHeldBackPackage, type PackageSummary } from '@inspectorhub/offline-package';
import { useCallback, useRef, useState } from 'react';
import type { Api } from '../../field/api-client';
import { exportFileName } from '../../export/format';
import { writeAndShare, type WriteAndShareDeps } from '../../export/share-package';
import { importPackage, realNextFrame, tenantMatches, type ImportDeps, type ImportOutcome } from '../../offline/import-package';
import { readPackageFile, type PickedFile } from '../../offline/package-source';
import { withLabels } from '../../offline/package-labels';
import { RUN_FAILED } from './copy';

/**
 * Progress counted in inspections, not parts: the package names a fixed number of inspections and each ends up imported or left
 * behind exactly once, while the number of parts grows as a refusal cuts the named inspection away.
 */
export interface ImportProgress {
  done: number;
  total: number;
  imported: number;
  heldBack: number;
}

export type ImportState =
  | { kind: 'choose'; error: string | null }
  | { kind: 'reading'; fileName: string }
  | { kind: 'preview'; fileName: string; summary: PackageSummary; error: string | null }
  | { kind: 'running'; fileName: string; summary: PackageSummary; progress: ImportProgress }
  | { kind: 'done'; fileName: string; summary: PackageSummary; outcome: ImportOutcome; labels: ReadonlyMap<string, string> };

export interface ImportPackageDeps {
  api: Pick<Api, 'send'>;
  tenantId: string;
  /** What writes a held-back part into the cache and opens the share sheet. */
  share: Omit<WriteAndShareDeps, 'retainMs'>;
  now(): number;
  /** Replaces the waits, the clock and the frame wait of the import. Tests only. */
  importDeps?: Partial<Pick<ImportDeps, 'sleep' | 'now' | 'nextFrame'>>;
}

const CHOOSE: ImportState = { kind: 'choose', error: null };

export type SaveResult = 'saved' | 'cancelled' | 'failed';

/** The steps of an import: choose, preview, run, result. The package bytes (up to 24 MiB) stay in a ref so a render never copies them. */
export function useImportPackage(deps: ImportPackageDeps) {
  const [state, setState] = useState<ImportState>(CHOOSE);
  const bytes = useRef<Uint8Array | null>(null);
  const picked = useRef<{ fileName: string; summary: PackageSummary; labels: ReadonlyMap<string, string> } | null>(null);
  const latest = useRef(deps);
  latest.current = deps;

  const choose = useCallback(async (file: PickedFile) => {
    bytes.current = null;
    picked.current = null;
    // Unpacking the manifest runs on the page's thread: the screen says what is happening before it starts.
    setState({ kind: 'reading', fileName: file.name });
    await (latest.current.importDeps?.nextFrame ?? realNextFrame)();
    const read = await readPackageFile(file);
    if (read.kind === 'refused') {
      setState({ kind: 'choose', error: read.message });
      return;
    }
    bytes.current = read.bytes;
    picked.current = { fileName: read.fileName, summary: read.summary, labels: read.labels };
    setState({ kind: 'preview', fileName: read.fileName, summary: read.summary, error: null });
  }, []);

  const reset = useCallback(() => {
    bytes.current = null;
    picked.current = null;
    setState(CHOOSE);
  }, []);

  /** Runs the import of the chosen package. The caller guards it against a second call in the same frame. */
  const start = useCallback(async () => {
    const zip = bytes.current;
    const chosen = picked.current;
    if (zip === null || chosen === null) return;
    const { api, tenantId, importDeps } = latest.current;
    // The preview already disables this; a package for another company is never sent, whatever calls here.
    if (!tenantMatches(chosen.summary, tenantId)) return;
    const total = Math.max(1, chosen.summary.counts.inspections);
    setState({ kind: 'running', fileName: chosen.fileName, summary: chosen.summary, progress: { done: 0, total, imported: 0, heldBack: 0 } });
    try {
      const outcome = await importPackage(zip, { api, ...importDeps }, (p) => {
        setState((s) => (s.kind === 'running' ? { ...s, progress: { done: Math.min(s.progress.total, p.imported + p.heldBack), total: s.progress.total, imported: p.imported, heldBack: p.heldBack } } : s));
      });
      setState({ kind: 'done', fileName: chosen.fileName, summary: chosen.summary, outcome, labels: chosen.labels });
    } catch {
      // Rejects only for a package the shared reader cannot read; nothing was sent.
      setState({ kind: 'preview', fileName: chosen.fileName, summary: chosen.summary, error: RUN_FAILED });
    }
  }, []);

  /** Saves the listed inspections, left behind by the import, as a package of their own and opens the share sheet. */
  const savePart = useCallback(async (ids: readonly string[]): Promise<SaveResult> => {
    const zip = bytes.current;
    if (zip === null) return 'failed';
    try {
      // The library cuts a part without the addresses; they are put back for the inspections the part holds.
      const part = withLabels(extractHeldBackPackage(zip, ids), picked.current?.labels ?? new Map());
      const { share, now } = latest.current;
      const result = await writeAndShare(share, exportFileName(now()), (async function* () { yield part; })());
      return result.result === 'shared' ? 'saved' : 'cancelled';
    } catch {
      return 'failed';
    }
  }, []);

  return { state, choose, reset, start, savePart };
}
