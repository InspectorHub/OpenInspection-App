import { describe, expect, it } from 'vitest';
import type { AppServices } from '../../app/compose';
import { createDiagRig } from '../test-support';
import { filesCheck, sanitizeMessage, STAT_MESSAGE_LIMIT } from './files';

describe('files', () => {
  it('writes diagnostic JPEG data with its real file signature', async () => {
    const rig = await createDiagRig({ signedIn: false });
    let prefix: Uint8Array | undefined;
    const original = rig.ctx.services.files.write;
    rig.ctx.services.files.write = async (path, data) => {
      if (path === 'media/diag-file.jpg') prefix = data.slice(0, 3);
      return original(path, data);
    };
    await filesCheck.run(rig.ctx);
    expect(prefix).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
  });

  it('passes, reports the mtime unit and the raw missing-file answer, and removes what it wrote', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const result = await filesCheck.run(rig.ctx);
    expect(result).toMatchObject({ id: 'files', ok: true });
    expect(result.detail).toContain('size=3145728');
    expect(result.detail).toMatch(/mtime_digits=13 mtime_ge_1e12=yes/);
    expect(result.detail).toContain('file_uri=yes image_load=yes missing_exists=false');
    expect(result.detail).toContain('stat_missing_code=OS-PLUG-FILE-0008 stat_missing_msg="File does not exist: <path>"');
    expect(result.detail).toContain('cache=ok');
    expect(result.detail).toContain('free_estimate=100MB');
    expect(rig.world.files.paths()).toEqual([]);
    expect(rig.ports.images).toHaveLength(1);
  });

  it('control: an mtime in seconds is reported and fails the check', async () => {
    const rig = await createDiagRig({
      signedIn: false,
      wrap: (s): AppServices => ({
        ...s,
        files: {
          ...s.files,
          write: async (path, data) => {
            const uri = await s.files.write(path, data);
            rig.world.files.setMtime(path, 1_700_000_000);
            return uri;
          },
        },
      }),
    });
    const result = await filesCheck.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mtime=1700000000 mtime_digits=10 mtime_ge_1e12=no');
    expect(rig.world.files.paths()).toEqual([]);
  });

  it('control: an image that does not load fails the check', async () => {
    const rig = await createDiagRig({ signedIn: false });
    rig.ports.imageLoads = false;
    const result = await filesCheck.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('image_load=no');
  });

  it('control: a stat that unexpectedly succeeds for a missing file is reported', async () => {
    const rig = await createDiagRig({ signedIn: false });
    rig.ports.statMissing = () => Promise.resolve(null);
    const result = await filesCheck.run(rig.ctx);
    expect(result.detail).toContain('stat_missing=succeeded');
  });

  it('reports a thrown write as a fixed word, never the message', async () => {
    const rig = await createDiagRig({
      signedIn: false,
      wrap: (s): AppServices => ({ ...s, files: { ...s.files, write: () => Promise.reject(new TypeError('/data/user/0/secret/path failed')) } }),
    });
    const result = await filesCheck.run(rig.ctx);
    expect(result).toMatchObject({ ok: false, detail: 'threw TypeError' });
  });
});

describe('sanitizeMessage', () => {
  it('replaces the diagnostic path and keeps a message of 150 characters whole (the old 80 would have cut it)', () => {
    const message = `File does not exist: media/diag-ab12.bin ${'x'.repeat(110)}`;
    const out = sanitizeMessage(message);
    expect(STAT_MESSAGE_LIMIT).toBe(200);
    expect(out).toBe(`File does not exist: <path> ${'x'.repeat(110)}`);
    expect(out.length).toBeGreaterThan(80);
  });

  it('control: a longer message is cut at the limit, and non-printable characters become ?', () => {
    expect(sanitizeMessage('y'.repeat(500))).toHaveLength(200);
    expect(sanitizeMessage('a\u00e9b')).toBe('a?b');
  });
});
