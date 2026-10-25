import { beforeEach, describe, expect, it } from 'vitest';
import { createBlockedGuard } from '../offline/blocked';
import { enqueue, markFailed, type Account } from '../offline/outbox';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createEditorLoader } from './editor-data';
import { MESSAGES } from './messages';
import { ALICE, BOB, envelope, seedPackage } from './test-support/seed-package';

let db: Db;
const clock = createManualClock(1000);

const loaderFor = (account: Account) => createEditorLoader({ db, account, isBlocked: createBlockedGuard(db) });
const queue = (op: string, input: unknown, account: Account = ALICE) => enqueue({ db, clock }, op, input, { account });

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

describe('editor data: what the first screen is built from', () => {
  it('loads the cached package into the loader shape', async () => {
    await seedPackage(db, 'i1');
    const data = await loaderFor(ALICE)('i1');
    expect(data.inspection).toMatchObject({ id: 'i1', status: 'draft', propertyAddress: '1 Main St' });
    expect(data.inspection).not.toHaveProperty('templateSnapshot');
    expect(data.resultId).toBe('res-1');
    expect(data.ratingLevels).toEqual([{ id: 'good', label: 'Good', color: '#0a0' }]);
    expect(data.tagLibrary).toEqual([{ id: 't1', name: 'Urgent', color: '#f00' }]);
    expect(data.defectCategories).toEqual([{ id: 'c1', name: 'Safety', color: '#f80' }]);
    expect(data.outboundCoolingWindow).toEqual({ unlockAtMs: 1_800_000_000_000, turnstileSiteKey: 'site-key' });
    expect(data.unitInspectionMode).toBe('tagged');
    expect(data.nextPublishIsAmendment).toBe(false);
  });

  it('overlays report-data onto the snapshot and keeps the raw snapshot apart', async () => {
    await seedPackage(db, 'i1');
    const data = await loaderFor(ALICE)('i1');
    const cover = data.schema.sections[0]?.items.find((item) => item.id === 'itm_cover');
    expect(cover?.attributes).toHaveLength(1);
    expect(data.schema.sections[0]?.title).toBe('Roof');
    expect(data.templateSnapshot.sections[0]).not.toHaveProperty('name');
    expect(data.templateSnapshot.schemaVersion).toBe(2);
  });

  it('slices results by the common scope: meta keys and unit findings stay out; a scope returns its own', async () => {
    await seedPackage(db, 'i1');
    const load = loaderFor(ALICE);
    const first = await load('i1');
    expect(Object.keys(first.results)).toEqual(['_default:sec_roof:itm_cover', '_default:sec_roof:itm_flashing']);
    expect(first.results).not.toHaveProperty('_inspector_signature');
    const unit = await load('i1', 'unit-1');
    expect(Object.keys(unit.results)).toEqual(['unit-1:sec_roof:itm_cover']);
  });

  it('keeps statutoryCoverage null as null, and an answered one as it is', async () => {
    await seedPackage(db, 'i1');
    const none = await loaderFor(ALICE)('i1');
    expect(none.statutoryCoverage).toBeNull();
    expect(none.statutoryDetails).toBeNull();
    await seedPackage(db, 'i2', {
      bodies: {
        '/api/inspections/i2/statutory-form/coverage': envelope({ formId: 'f', formTitle: 'Form', revision: null, requiredTotal: 4, missing: [] }),
        '/api/inspections/i2/statutory-details': envelope({ ownerName: 'Dana' }),
      },
    });
    const answered = await loaderFor(ALICE)('i2');
    expect(answered.statutoryCoverage).toEqual({ formId: 'f', formTitle: 'Form', revision: null, requiredTotal: 4, missing: [] });
    expect(answered.statutoryDetails).toEqual({ ownerName: 'Dana' });
  });

  it('has no source for revisionStatus: it is null', async () => {
    await seedPackage(db, 'i1');
    expect((await loaderFor(ALICE)('i1')).revisionStatus).toBeNull();
  });

  it('supplies the loader defaults when optional reads were not cached, and resolves the commercial values', async () => {
    await seedPackage(db, 'i1', { skipGlobals: true, inspection: { pcaNarrative: { purpose: 'Own purpose.', pointInTime: 'Own wording.' } } });
    const data = await loaderFor(ALICE)('i1');
    expect(data.units).toEqual([]);
    expect(data.unitProgress).toEqual({ units: [], commonRated: 0, total: 0 });
    expect(data.tagLibrary).toEqual([]);
    expect(data.outboundCoolingWindow).toBeNull();
    expect(data.compliance).toEqual({ reportSignoffs: [], psq: null, documentReview: [], conformance: { standard: 'E2018-24', conforms: false } });
    expect(data.pcaNarrative.purpose).toBe('Own purpose.');
    expect(data.pcaNarrative.scopeOfWork.length).toBeGreaterThan(20);
    expect(data.relianceText.pointInTime).toBe('Own wording.');
    expect(Object.keys(data.commercialPresets)).toContain('commercial:office');
  });

  it('reads units, progress and a per-unit mode from the cache when they were downloaded', async () => {
    await seedPackage(db, 'i1', {
      inspection: { propertyType: 'multi_unit', unitInspectionMode: 'per_unit', reportStatus: 'published' },
      bodies: {
        '/api/inspections/i1/units': envelope({ units: [{ id: 'unit-1', name: 'A', kind: 'unit', type: 'unit', parentUnitId: null, sortOrder: 1 }] }),
        '/api/inspections/i1/unit-progress': envelope({ units: [{ unitId: 'unit-1', rated: 1, total: 2 }], commonRated: 1, total: 2 }),
      },
    });
    const data = await loaderFor(ALICE)('i1');
    expect(data.units).toHaveLength(1);
    expect(data.unitProgress.total).toBe(2);
    expect(data.unitInspectionMode).toBe('per_unit');
    expect(data.nextPublishIsAmendment).toBe(true);
  });
});

describe('editor data: what it refuses', () => {
  it('refuses a blocked inspection with the blocked sentence; the same inspection loads when it is not blocked', async () => {
    await seedPackage(db, 'i1');
    await expect(loaderFor(ALICE)('i1')).resolves.toBeDefined();
    await db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['i1']);
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.blocked);
    await db.run("UPDATE work_package SET purging = 0, quarantine_source = 'reconcile_missing' WHERE inspection_id = ?", ['i1']);
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.blocked);
  });

  it('refuses a package that belongs to another account, even for a user of the same company', async () => {
    await seedPackage(db, 'i1', { owner: BOB });
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.unavailable);
    await expect(loaderFor(BOB)('i1')).resolves.toBeDefined();
  });

  it('cannot reach cached rows stored under a different account key, whatever the package row says', async () => {
    await seedPackage(db, 'i1', { owner: ALICE, rowsFor: BOB });
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.notDownloaded);
  });

  it('rejects a missing cache; it never returns an empty shell', async () => {
    await expect(loaderFor(ALICE)('nope')).rejects.toThrow(MESSAGES.unavailable);
    await seedPackage(db, 'i1', { bodies: { '/api/inspections/i1/report-data': null } });
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.notDownloaded);
  });

  it('rejects an unreadable inspection body, and one that is about a different inspection', async () => {
    await seedPackage(db, 'i1', { bodies: { '/api/inspections/i1': '{not json' } });
    await expect(loaderFor(ALICE)('i1')).rejects.toThrow(MESSAGES.notDownloaded);
    await seedPackage(db, 'i2', { bodies: { '/api/inspections/i2': envelope({ inspection: { id: 'other' } }) } });
    await expect(loaderFor(ALICE)('i2')).rejects.toThrow(MESSAGES.notDownloaded);
  });

  it('rejects an id that is not an inspection id before touching the database', async () => {
    await expect(loaderFor(ALICE)('../etc')).rejects.toThrow(MESSAGES.unavailable);
    await expect(loaderFor(ALICE)('bulk')).rejects.toThrow(MESSAGES.unavailable);
  });
});

describe('editor data: queued writes are shown, so a reload does not undo them', () => {
  it('a pending complete reads as completed; without one the cached status is kept', async () => {
    await seedPackage(db, 'i1');
    expect((await loaderFor(ALICE)('i1')).inspection.status).toBe('draft');
    await queue('inspection.complete', { inspectionId: 'i1' });
    expect((await loaderFor(ALICE)('i1')).inspection.status).toBe('completed');
  });

  it('a complete queued for another inspection or by another account does not touch this one', async () => {
    await seedPackage(db, 'i1');
    await queue('inspection.complete', { inspectionId: 'other' });
    await queue('inspection.complete', { inspectionId: 'i1' }, BOB);
    expect((await loaderFor(ALICE)('i1')).inspection.status).toBe('draft');
  });

  it('a complete that failed for good is not shown as done', async () => {
    await seedPackage(db, 'i1');
    const row = await queue('inspection.complete', { inspectionId: 'i1' });
    await markFailed(db, row.idempotencyKey, 'rejected');
    expect((await loaderFor(ALICE)('i1')).inspection.status).toBe('draft');
  });

  it('a cancelled inspection stays cancelled: the server would refuse the complete', async () => {
    await seedPackage(db, 'i1', { inspection: { status: 'cancelled' } });
    await queue('inspection.complete', { inspectionId: 'i1' });
    expect((await loaderFor(ALICE)('i1')).inspection.status).toBe('cancelled');
  });

  it('a pending settings change is laid over the cached row, oldest first', async () => {
    await seedPackage(db, 'i1');
    await queue('inspection.update', { inspectionId: 'i1', changes: { propertyAddress: '2 Oak Avenue', sqft: 1200 } });
    await queue('inspection.update', { inspectionId: 'i1', changes: { sqft: 1500 } });
    const data = await loaderFor(ALICE)('i1');
    expect(data.inspection).toMatchObject({ propertyAddress: '2 Oak Avenue', sqft: 1500 });
  });
});
