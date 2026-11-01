import { useEffect, useId, useState } from 'react';
import type { AppServices } from '../../app/compose';
import { Body } from '../kit';

export const GALLERY_LABEL = 'Save photos I take to my gallery';
export const GALLERY_EXPLANATION =
  "Keeps a copy of each photo you take in this app in your device's photo library. The app never deletes these copies, and they are not removed when you sign out or clear local data. Your device may back up its photo library to a cloud account.";

export interface GallerySectionProps {
  services: Pick<AppServices, 'photoGallery' | 'gallerySetting'>;
}

/**
 * The choice to keep a copy of the photos taken in the app in the device's photo library. Off until the person turns it on. Absent
 * where this build has no way to save one, so there is never a switch that does nothing.
 */
export function GallerySection({ services }: GallerySectionProps) {
  const headingId = useId();
  const switchId = useId();
  const available = services.photoGallery.available();
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!available) return;
    let live = true;
    services.gallerySetting.get().then(
      (value) => {
        if (live) setOn(value);
      },
      () => {
        if (live) setOn(false);
      },
    );
    return () => {
      live = false;
    };
  }, [available, services.gallerySetting]);

  if (!available || on === null) return null;

  function change(next: boolean): void {
    // The switch shows the new state at once; if it cannot be stored it goes back, so what it shows is what will happen.
    setOn(next);
    services.gallerySetting.set(next).catch(() => setOn(!next));
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Photos
      </h2>
      <label htmlFor={switchId} className="flex min-h-11 items-center gap-3 text-base font-semibold text-ih-fg-1">
        <input id={switchId} type="checkbox" className="size-5 shrink-0 accent-ih-primary" checked={on} onChange={(event) => change(event.target.checked)} />
        <span>{GALLERY_LABEL}</span>
      </label>
      <Body>{GALLERY_EXPLANATION}</Body>
    </section>
  );
}
