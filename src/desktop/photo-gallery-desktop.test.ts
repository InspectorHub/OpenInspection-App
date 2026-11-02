import { describe, expect, it } from 'vitest';
import { IpcError } from '../../electron/shared/ipc-contract';
import { createDesktopGallery } from './photo-gallery-desktop';

const NAME = 'InspectorHub-20261102-101500-ab12cd34.jpg';
const INFO = { name: NAME, createdAt: Date.UTC(2026, 10, 2, 10, 15) };
const PHOTO = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' });

function bridge(save: (name: string, data: Uint8Array) => Promise<'saved'>) {
  const calls: Array<{ name: string; bytes: number[] }> = [];
  return { calls, gallery: { save: (name: string, data: Uint8Array) => { calls.push({ name, bytes: [...data] }); return save(name, data); } } };
}

describe('createDesktopGallery', () => {
  it('hands the name and the photo\'s bytes to the bridge, and says saved', async () => {
    const fake = bridge(() => Promise.resolve('saved'));
    const gallery = createDesktopGallery(fake);
    expect(gallery.available()).toBe(true);
    expect(await gallery.save(PHOTO, INFO)).toBe('saved');
    expect(fake.calls).toEqual([{ name: NAME, bytes: [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3] }]);
  });

  it('a refused write (the folder cannot be written) is denied; a full disk or anything else is failed; save never throws', async () => {
    for (const [code, expected] of [['unavailable', 'denied'], ['disk-full', 'failed'], ['internal', 'failed'], ['invalid-argument', 'failed']] as const) {
      const gallery = createDesktopGallery(bridge(() => Promise.reject(new IpcError(code))));
      await expect(gallery.save(PHOTO, INFO)).resolves.toBe(expected);
    }
    await expect(createDesktopGallery(bridge(() => Promise.reject(new Error('boom')))).save(PHOTO, INFO)).resolves.toBe('failed');
    await expect(createDesktopGallery(bridge(() => Promise.reject('text'))).save(PHOTO, INFO)).resolves.toBe('failed'); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
  });
});
