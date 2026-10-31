import { describe, expect, it } from 'vitest';
import type { PhotoDiagnostic } from '../app/diagnostics';
import { MediaError } from '../media/errors';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory, type UploaderDeps } from './uploader';

/** A photo answered as a plain failure that is not a policy refusal leaves one fixed code; a kept photo leaves none. */
async function rig(over: (w: UploaderWorld) => Partial<UploaderDeps> = () => ({}), online = true) {
  const w = await createUploaderWorld();
  const codes: PhotoDiagnostic[] = [];
  const factory = createUploaderFactory({ ...w.deps, ...over(w), onDiagnostic: (code) => codes.push(code), isOnline: () => online });
  return { w, codes, upload: () => factory(INSPECTION, null).upload(photoRecord('p1')) };
}

const stub = (code: string, retryable = true): Partial<UploaderDeps> => ({
  native: { uploadDetailed: () => Promise.resolve({ ok: false as const, code: code as 'NETWORK', retryable, retryAfterMs: null, halt: false }) },
});

describe('photo diagnostics', () => {
  it('a blocked inspection at the start', async () => {
    const r = await rig();
    r.w.blocked.add(INSPECTION);
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:blocked_at_start:NONE:online']);
  });

  it('a blocked outcome from the background uploader', async () => {
    const r = await rig(() => stub('BLOCKED'));
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:blocked_outcome:BLOCKED:online']);
  });

  it('a failure with nothing to keep', async () => {
    const r = await rig(() => stub('NOT_FOUND', false), false);
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:nothing_to_keep:NOT_FOUND:offline']);
  });

  it('an unexpected throw', async () => {
    const r = await rig((w) => ({ store: { ...w.world.store, getRow: () => Promise.reject(new Error('/secret/path')) } }));
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:unexpected_throw:NONE:online']);
  });

  it('a device store that fails and a direct upload that fails too', async () => {
    const r = await rig((w) => ({
      store: { ...w.world.store, put: () => Promise.reject(new MediaError('DB_FAILED')) },
      foreground: { ...w.deps.foreground, itemPhotoDirect: () => Promise.resolve({ ok: false as const, error: 'x' }) },
    }));
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:store_trouble_direct_failed:DB_FAILED:online']);
  });

  it('a document entry that cannot be written', async () => {
    const r = await rig(() => stub('NETWORK'));
    r.w.docFailure.error = new MediaError('DOC_FAILED');
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:entry_failed:DOC_FAILED:NETWORK:online']);
  });

  it('a document that stays busy through every try', async () => {
    const r = await rig(() => stub('NETWORK'));
    r.w.docFailure.error = new MediaError('DOC_BUSY');
    const work = r.upload();
    for (let i = 0; i < 100 && r.codes.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (r.w.docTimers.pending() > 0) r.w.docTimers.fireNext();
    }
    await work;
    expect(r.codes).toEqual(['photo_not_kept:entry_failed:DOC_BUSY:NETWORK:online']);
  });

  it('a blocked document while the entry is written', async () => {
    const r = await rig(() => stub('NETWORK'));
    r.w.docFailure.error = new MediaError('BLOCKED');
    await r.upload();
    expect(r.codes).toEqual(['photo_not_kept:entry_blocked:NETWORK:online']);
  });

  it('a kept photo and a policy refusal leave nothing', async () => {
    const kept = await rig(() => stub('NETWORK'));
    expect(await kept.upload()).toMatchObject({ kept: true });
    const refused = await rig((w) => ({ store: { ...w.world.store, put: () => Promise.reject(new MediaError('TOO_LARGE')) } }));
    expect(await refused.upload()).toMatchObject({ permanent: true });
    expect([...kept.codes, ...refused.codes]).toEqual([]);
  });
});
