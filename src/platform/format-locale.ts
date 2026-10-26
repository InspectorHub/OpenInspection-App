/**
 * The locale every date, time, relative time and number is formatted in.
 *
 * The interface text is English only, so what it says about time must be English too: left to the device, a phone set to
 * another language writes the time part in that language inside an English sentence. The time ZONE is not part of this: it stays the
 * device's own, because a calendar day is the day where the person is standing.
 *
 * When the interface is translated, this is the one place to change: the formatting locale must follow the interface
 * language from then on, never the other way round. `src/format-locale.test.ts` fails for any formatting call that does not
 * take its locale from here.
 */
export const FORMAT_LOCALE = 'en-US';
