import { vi } from 'vitest';

type Ctor = new (locales?: string | string[], options?: object) => object;

/**
 * Makes a device whose own language is `tag`: a formatter built without a locale uses it, and `navigator.language` reports
 * it. A formatter given a locale uses that one, as the real ones do. Undo with `vi.unstubAllGlobals()`.
 */
export function stubDeviceLocale(tag: string): void {
  const date = Intl.DateTimeFormat as unknown as Ctor;
  const relative = Intl.RelativeTimeFormat as unknown as Ctor;
  const number = Intl.NumberFormat as unknown as Ctor;
  const wrap = (Base: Ctor): Ctor =>
    class extends (Base as unknown as new (...args: unknown[]) => object) {
      constructor(locales?: string | string[], options?: object) {
        super(locales ?? tag, options);
      }
    } as unknown as Ctor;
  vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: wrap(date), RelativeTimeFormat: wrap(relative), NumberFormat: wrap(number) });
  vi.stubGlobal('navigator', { ...(typeof navigator === 'undefined' ? {} : navigator), language: tag, languages: [tag] });
  // `toLocale*String` read the default locale too.
  const original = Date.prototype.toLocaleString;
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return original.call(this, locales ?? tag, options);
  });
}
