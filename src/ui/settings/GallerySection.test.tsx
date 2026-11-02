// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createGallerySetting, GALLERY_SETTING_KEY } from '../../field/gallery-copy';
import { createMemoryKeyValue } from '../../platform/kv';
import { createMemoryGallery, unavailableGallery } from '../../platform/photo-gallery';
import { GALLERY_EXPLANATION, GALLERY_LABEL, GallerySection } from './GallerySection';

afterEach(cleanup);

function rig(options: { available?: boolean } = {}, initial: Record<string, string> = {}) {
  const kv = createMemoryKeyValue(initial);
  const services = {
    photoGallery: options.available === false ? unavailableGallery : createMemoryGallery(),
    gallerySetting: createGallerySetting(kv),
  };
  return { kv, services };
}

describe('the gallery section of Settings', () => {
  it('is absent where this build cannot save to a gallery (no switch that does nothing)', async () => {
    const { services } = rig({ available: false });
    const { container } = render(<GallerySection services={services} />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the switch off by default, with the explanation that the app never deletes the copies', async () => {
    const { services } = rig();
    render(<GallerySection services={services} />);
    const box = await screen.findByRole('checkbox', { name: GALLERY_LABEL });
    expect(box).not.toBeChecked();
    expect(screen.getByText(GALLERY_EXPLANATION)).toBeInTheDocument();
    expect(GALLERY_EXPLANATION).toContain('never deletes');
    expect(GALLERY_EXPLANATION).toContain('back up');
  });

  it('turning it on stores the choice, and turning it off stores that too', async () => {
    const { kv, services } = rig();
    render(<GallerySection services={services} />);
    const box = await screen.findByRole('checkbox', { name: GALLERY_LABEL });
    await userEvent.click(box);
    await waitFor(() => expect(kv.entries()[GALLERY_SETTING_KEY]).toBe('1'));
    expect(box).toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(kv.entries()[GALLERY_SETTING_KEY]).toBe('0'));
    expect(box).not.toBeChecked();
  });

  it('shows the stored choice when the screen opens', async () => {
    const { services } = rig({}, { [GALLERY_SETTING_KEY]: '1' });
    render(<GallerySection services={services} />);
    expect(await screen.findByRole('checkbox', { name: GALLERY_LABEL })).toBeChecked();
  });

  it('goes back to the old state when the choice cannot be stored, so the switch tells the truth', async () => {
    const { services } = rig();
    const failing = { ...services, gallerySetting: { get: () => Promise.resolve(false), set: () => Promise.reject(new Error('disk')) } };
    render(<GallerySection services={failing} />);
    const box = await screen.findByRole('checkbox', { name: GALLERY_LABEL });
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
  });
});
