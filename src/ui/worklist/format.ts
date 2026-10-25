/** Which part of the work list an inspection sits under. */
export type GroupKey = 'today' | 'tomorrow' | 'later' | 'earlier' | 'unscheduled';

/** The order a person works through them: what is next first, what is overdue after, what has no date last. */
export const GROUP_ORDER: readonly GroupKey[] = ['today', 'tomorrow', 'later', 'earlier', 'unscheduled'];

export const GROUP_TITLES: Record<GroupKey, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  later: 'Later',
  earlier: 'Earlier',
  unscheduled: 'Not scheduled',
};

/** The number of the device's calendar day, so two times on the same day give the same number whatever the hour. */
function dayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** The group of a scheduled time, by the device's own calendar day. */
export function groupOf(scheduledAt: number | null, now: number): GroupKey {
  if (scheduledAt === null || !Number.isFinite(scheduledAt)) return 'unscheduled';
  const diff = dayNumber(scheduledAt) - dayNumber(now);
  if (diff < 0) return 'earlier';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return 'later';
}

function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat(undefined, options);
  }
}

/** The time of day for today and tomorrow, the date and time for other days, null when there is no date. */
export function whenLabel(scheduledAt: number | null, group: GroupKey, locale?: string): string | null {
  if (scheduledAt === null || group === 'unscheduled') return null;
  if (group === 'today' || group === 'tomorrow') return formatter(locale, { hour: 'numeric', minute: '2-digit' }).format(scheduledAt);
  return formatter(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(scheduledAt);
}

function relative(at: number, now: number, locale: string | undefined): string {
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  }
  // A time in the future means the clock moved: read it as "now" rather than invent a countdown.
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return rtf.format(0, 'minute');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.floor(hours / 24), 'day');
}

/** "Updated 5 minutes ago", in the device's language for the time part. Never a raw timestamp. */
export function updatedLabel(at: number | null, now: number, locale?: string): string {
  return at === null ? 'Not updated yet' : `Updated ${relative(at, now, locale)}`;
}

/** "Checked 2 minutes ago", or "Not checked yet". */
export function checkedLabel(at: number | null, now: number, locale?: string): string {
  return at === null ? 'Not checked yet' : `Checked ${relative(at, now, locale)}`;
}
