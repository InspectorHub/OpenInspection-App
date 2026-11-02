import { describe, expect, it } from 'vitest';
import { albumFileName, createCapacitorGallery, GALLERY_ALBUM_NAME, type MediaPluginLike } from './photo-gallery-capacitor';

/** A stand-in for the plugin that remembers what it was asked and can be told to refuse. */
function fakeMedia(options: { albums?: Array<{ identifier: string; name: string }>; albumsPath?: string; saveError?: Error; createError?: Error; hideCreated?: boolean } = {}) {
  const albums = [...(options.albums ?? [])];
  const calls: string[] = [];
  const saved: Array<{ path: string; albumIdentifier?: string; fileName?: string }> = [];
  const albumsPath = options.albumsPath ?? '/storage/emulated/0/Pictures';
  const media: MediaPluginLike = {
    savePhoto: (o) => {
      calls.push('savePhoto');
      if (options.saveError) return Promise.reject(options.saveError);
      saved.push(o);
      return Promise.resolve({});
    },
    createAlbum: ({ name }) => {
      calls.push(`createAlbum:${name}`);
      if (options.createError) return Promise.reject(options.createError);
      if (!options.hideCreated) albums.push({ identifier: `${albumsPath}/${name}`, name });
      return Promise.resolve();
    },
    getAlbums: () => { calls.push('getAlbums'); return Promise.resolve({ albums: [...albums] }); },
    getAlbumsPath: () => { calls.push('getAlbumsPath'); return Promise.resolve({ path: albumsPath }); },
  };
  return { media, calls, saved, albums };
}

const JPEG = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' });
const INFO = { name: 'InspectorHub-20261102-101500-ab12cd34.jpg', createdAt: Date.UTC(2026, 10, 2, 10, 15) };

describe('createCapacitorGallery on Android', () => {
  it('creates the InspectorHub album on first use, saves the photo into it as a data URL, and says saved', async () => {
    const fake = fakeMedia();
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    expect(gallery.available()).toBe(true);
    expect(await gallery.save(JPEG, INFO)).toBe('saved');
    expect(fake.calls).toContain(`createAlbum:${GALLERY_ALBUM_NAME}`);
    expect(fake.saved).toHaveLength(1);
    const [only] = fake.saved;
    expect(only?.albumIdentifier).toBe(`/storage/emulated/0/Pictures/${GALLERY_ALBUM_NAME}`);
    expect(only?.fileName).toBe('InspectorHub-20261102-101500-ab12cd34'); // no extension: the plugin adds it
    expect(only?.path.startsWith('data:image/jpeg;base64,')).toBe(true);
    // The bytes are the photo's: 0xff 0xd8 0xff 0xe0 0x01 0x02 0x03.
    expect(only?.path.slice('data:image/jpeg;base64,'.length)).toBe(btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)));
  });

  it('uses an album that already exists, and does not create a second one (control: the first test creates one)', async () => {
    const fake = fakeMedia({ albums: [{ identifier: `/storage/emulated/0/Pictures/${GALLERY_ALBUM_NAME}`, name: GALLERY_ALBUM_NAME }] });
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    expect(await gallery.save(JPEG, INFO)).toBe('saved');
    expect(fake.calls.some((call) => call.startsWith('createAlbum'))).toBe(false);
  });

  it('does not take another app\'s album of the same name for ours: the identifier must be under the albums path', async () => {
    const fake = fakeMedia({ albums: [{ identifier: '/storage/emulated/0/Download/InspectorHub', name: GALLERY_ALBUM_NAME }] });
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    expect(await gallery.save(JPEG, INFO)).toBe('saved');
    expect(fake.calls).toContain(`createAlbum:${GALLERY_ALBUM_NAME}`);
    expect(fake.saved[0]?.albumIdentifier).toBe(`/storage/emulated/0/Pictures/${GALLERY_ALBUM_NAME}`);
  });

  it('looks the album up once and remembers it for the next photos', async () => {
    const fake = fakeMedia();
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    await gallery.save(JPEG, INFO);
    const lookups = fake.calls.filter((call) => call === 'getAlbums').length;
    await gallery.save(JPEG, { ...INFO, name: 'InspectorHub-20261102-101600-ef56ab78.jpg' });
    expect(fake.calls.filter((call) => call === 'getAlbums').length).toBe(lookups);
    expect(fake.saved).toHaveLength(2);
  });

  it('forgets a remembered album after a failure (the person may have deleted it), and finds or creates it again', async () => {
    const fake = fakeMedia();
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    await gallery.save(JPEG, INFO);
    fake.albums.length = 0; // the person deleted the album
    expect(await gallery.save(JPEG, INFO)).toBe('saved'); // still the remembered identifier, the (fake) plugin does not mind
    const failing = fakeMedia({ saveError: new Error('boom') });
    const g2 = createCapacitorGallery({ platform: 'android', media: failing.media });
    expect(await g2.save(JPEG, INFO)).toBe('failed');
    expect(failing.calls.filter((call) => call === 'getAlbums').length).toBe(2); // looked up, created, looked up again
  });

  it.each([
    ['Permission denied', 'denied'],
    ['Access to photo library was denied by the user', 'denied'],
    ['Not authorized to access media', 'denied'],
    ['disk full', 'failed'],
    ['', 'failed'],
  ])('a rejection "%s" is %s, and save never throws', async (message, expected) => {
    const fake = fakeMedia({ saveError: new Error(message) });
    const gallery = createCapacitorGallery({ platform: 'android', media: fake.media });
    await expect(gallery.save(JPEG, INFO)).resolves.toBe(expected);
  });

  it('a plugin that rejects with something that is not an Error is still a value, not a throw', async () => {
    const media = fakeMedia().media;
    media.savePhoto = () => Promise.reject({ message: 'Permission denied' }); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    expect(await createCapacitorGallery({ platform: 'android', media }).save(JPEG, INFO)).toBe('denied');
    media.savePhoto = () => Promise.reject('plain text'); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    expect(await createCapacitorGallery({ platform: 'android', media }).save(JPEG, INFO)).toBe('failed');
  });

  it('an album that cannot be created or found is a failure, not a throw', async () => {
    expect(await createCapacitorGallery({ platform: 'android', media: fakeMedia({ createError: new Error('nope') }).media }).save(JPEG, INFO)).toBe('failed');
    expect(await createCapacitorGallery({ platform: 'android', media: fakeMedia({ hideCreated: true }).media }).save(JPEG, INFO)).toBe('failed');
  });
});

describe('createCapacitorGallery on iOS', () => {
  it('saves without an album, so the system asks for add-only access and not for the whole library', async () => {
    const fake = fakeMedia();
    const gallery = createCapacitorGallery({ platform: 'ios', media: fake.media });
    expect(await gallery.save(JPEG, INFO)).toBe('saved');
    expect(fake.calls).toEqual(['savePhoto']); // no album lookup, no createAlbum
    expect(fake.saved[0]?.albumIdentifier).toBeUndefined();
    expect(fake.saved[0]?.fileName).toBeUndefined(); // the plugin takes a file name on Android only
    expect(fake.saved[0]?.path.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('a refusal of the permission is denied', async () => {
    const fake = fakeMedia({ saveError: new Error('Access to the photo library is denied') });
    expect(await createCapacitorGallery({ platform: 'ios', media: fake.media }).save(JPEG, INFO)).toBe('denied');
  });
});

describe('albumFileName', () => {
  it.each([
    ['InspectorHub-20261102-101500-ab12cd34.jpg', 'InspectorHub-20261102-101500-ab12cd34'],
    ['photo.heic', 'photo'],
    ['no extension', 'noextension'],
    ['../../evil name.jpg', 'evilname'],
  ])('%s becomes %s', (name, expected) => {
    expect(albumFileName(name)).toBe(expected);
  });
});
