import type { HeldBack, ImportReport, NeedsAttention } from '@inspectorhub/offline-package';
import { describe, expect, it } from 'vitest';
import type { ImportOutcome } from '../../offline/import-package';
import { buildResult, mainTextOf } from './result-model';

const BIDI = String.fromCharCode(0x202e);

function outcome(held: HeldBack[], attention: NeedsAttention[] = []): ImportOutcome {
  const report: ImportReport = { imported: ['insp-0'], heldBack: held, skipped: 0, applied: 0, needsAttention: attention, requests: 1 };
  return { report, stopped: null, requested: new Set() };
}

const notFound = (id: string): HeldBack => ({ id, reason: 'not_found', status: 404, code: 'NOT_FOUND' });
const labels = new Map([
  ['insp-1', '12 Oak Street'],
  ['insp-2', '9 Elm Road'],
]);

describe('inspections are named by their address when the file has one', () => {
  it('a row shows the label; one without a label keeps the id form it always had', () => {
    const groups = buildResult(outcome([notFound('insp-1'), notFound('insp-3')]), labels).groups;
    expect(groups[0]?.rows.map((r) => r.name)).toEqual(['12 Oak Street', 'Inspection insp-3']);
  });

  it('without any labels every row is exactly as before', () => {
    const groups = buildResult(outcome([notFound('insp-1'), notFound('insp-2')])).groups;
    expect(groups[0]?.rows.map((r) => r.name)).toEqual(['Inspection insp-1', 'Inspection insp-2']);
  });

  it('the id stays reachable: it is in the details beside the label', () => {
    const details = buildResult(outcome([notFound('insp-1')]), labels).details.join('\n');
    expect(details).toContain('insp-1 (12 Oak Street): not_found. Server answer: 404 NOT_FOUND.');
  });

  it('the id is not in the main text of a labelled row, the label is', () => {
    const main = mainTextOf(buildResult(outcome([notFound('insp-1')]), labels));
    expect(main).toContain('12 Oak Street');
    expect(main).not.toContain('insp-1');
  });

  it('a change that was not applied names its inspection by address too, and by id when it has none', () => {
    const change = (id: string): NeedsAttention => ({ idempotencyKey: `k-${id}`, op: 'inspection.update', inspectionId: id, status: 422 });
    const rows = buildResult(outcome([], [change('insp-2'), change('insp-9')]), labels).attention?.rows;
    expect(rows).toEqual(['Change to 9 Elm Road', 'Change to inspection insp-9']);
  });

  it('a label is cleaned again here, in case a caller hands one in that was not', () => {
    const dirty = new Map([['insp-1', `Oak${BIDI} Street`]]);
    expect(buildResult(outcome([notFound('insp-1')]), dirty).groups[0]?.rows[0]?.name).toBe('Oak Street');
  });

  it('the labels do not change the sentences, the counts or the action', () => {
    const plain = buildResult(outcome([notFound('insp-1')]));
    const named = buildResult(outcome([notFound('insp-1')]), labels);
    expect(named.headline).toBe(plain.headline);
    expect(named.meaning).toEqual(plain.meaning);
    expect(named.primary).toEqual(plain.primary);
    expect(named.groups.map((g) => g.heading)).toEqual(plain.groups.map((g) => g.heading));
  });
});
