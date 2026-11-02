import { PACKAGE_MAX_AGE_DAYS, PACKAGE_MAX_FUTURE_SKEW_DAYS, type HeldBack } from '@inspectorhub/offline-package';
import type { ImportOutcome, StopProblem } from '../../offline/import-package';
import { cleanLabel } from '../../offline/cached-address';
import { stripBidi } from '../worklist/format';
import { answerText } from './copy';

/**
 * What the result page says, as plain data. The page is for someone tired, in a basement, on a phone: one sentence for what happened,
 * what it means for their data, one thing to do next, then the inspections that need a look, grouped by what happened to them.
 * Every number and answer code a person does not need sits in `details`, which the page shows only behind a "Details" button.
 *
 * Every claim is as true as what the code knows:
 *  - "Nothing was uploaded" is said only of inspections whose request never went out (`outcome.requested`).
 *  - A request that went out without an answer "may or may not" have arrived.
 *  - Days in the "too old" and "dated ahead" sentences are the ones the server named; the shared package's own figures only when it named none.
 */

/** One inspection in a list: named by its address when the file carried one, else by its id. */
export type ResultRow = HeldBack & { name: string };

export interface ResultGroup {
  key: string;
  /** What happened, in everyday words. Written for one or for several inspections. */
  heading: string;
  /** What to do next (and, where it is true, what is safe). */
  action: string;
  rows: ResultRow[];
  /** Trying the whole file again can help these. */
  retry: boolean;
  /** Saving these as a file of their own is useful. */
  save: boolean;
}

/** `signin` sends the person to the sign-in screen (the import is gone by then, so the file is chosen again afterwards). */
export type PrimaryKind = 'retry' | 'save' | 'done' | 'signin';

export interface ResultModel {
  headline: string;
  meaning: string[];
  primary: { kind: PrimaryKind; label: string; ids: string[] };
  secondary: Array<{ kind: 'another' | 'done'; label: string }>;
  /** Queued changes the server did not apply: shown on their own, in changes. */
  attention: { heading: string; intro: string; rows: string[] } | null;
  groups: ResultGroup[];
  /** Technical lines: the page shows them only when the person opens "Details". */
  details: string[];
}

/** Words that must not appear in the text a person reads (the details are exempt). Matched whole-word, in any case. */
export const BANNED_WORDS: readonly string[] = ['held back', 'gave up', 'refused', 'unsent', 'unconfirmed', 'stopped', 'not confirmed', 'part', 'package'];

/** Names of things on other screens that the page may quote, because the person has to find them there. */
const QUOTED_NAMES: readonly string[] = ['Import package'];

export function bannedWordsIn(text: string): string[] {
  const plain = QUOTED_NAMES.reduce((rest, name) => rest.split(name).join(' '), text);
  return BANNED_WORDS.filter((word) => new RegExp(`\\b${word.replace(' ', '\\s+')}\\b`, 'i').test(plain));
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

interface Words {
  These: string;
  these: string;
  them: string;
}

function wordsFor(n: number): Words {
  return n === 1 ? { These: 'This inspection', these: 'this inspection', them: 'it' } : { These: 'These', these: 'these', them: 'them' };
}

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
const days = (n: number): string => `${String(n)} ${n === 1 ? 'day' : 'days'}`;

interface Template {
  key: string;
  heading: string;
  action: string;
  retry: boolean;
  save: boolean;
}

const SAFE_TO_REPEAT = 'It may or may not have received {them}. Trying again is safe: anything it already received is skipped.';

const STOP_HINT: Record<StopProblem, string> = {
  auth: ' Sign in again first.',
  locked: ' Verify this device online first.',
  upgrade: ' Update the app first.',
  server_too_old: ' Your server also needs to be updated first.',
};

/** What the sign-in screen costs the person, said truthfully: leaving this screen discards the chosen file. */
const SIGN_IN_THEN_CHOOSE_AGAIN = 'Sign in again, then open Import package and choose the file again.';

function notSent(stopped: StopProblem, n: number, canSignIn: boolean): Template {
  const w = wordsFor(n);
  const nothing = `Nothing was uploaded for ${w.them}.`;
  const subject = n === 1 ? 'This inspection was' : 'These were';
  switch (stopped) {
    case 'auth':
      return {
        key: 'not_sent:auth',
        heading: `${subject} not sent because you were signed out.`,
        action: canSignIn ? `${nothing} ${SIGN_IN_THEN_CHOOSE_AGAIN} Anything already imported is skipped.` : `${nothing} Sign in again, then choose Try again.`,
        retry: true,
        save: false,
      };
    case 'locked':
      return { key: 'not_sent:locked', heading: `${subject} not sent because this device is locked.`, action: `${nothing} Verify this device online, then choose Try again.`, retry: true, save: false };
    case 'upgrade':
      return { key: 'not_sent:upgrade', heading: `${subject} not sent because this version of the app is too old for your server.`, action: `${nothing} Update the app, then import the file again.`, retry: false, save: false };
    case 'server_too_old':
      return { key: 'not_sent:server_too_old', heading: `${subject} not sent because your server is too old for this app.`, action: `${nothing} Ask whoever runs your server to update it, then try again.`, retry: false, save: false };
  }
}

function noAnswer(h: HeldBack, n: number, stopped: StopProblem | null, canSignIn: boolean): Template {
  const w = wordsFor(n);
  const safe = SAFE_TO_REPEAT.replace('{them}', w.them);
  const hint = stopped === 'auth' && canSignIn ? ' Sign in again first, then open Import package and choose the file again.' : stopped === null ? '' : STOP_HINT[stopped];
  const retry = stopped !== 'upgrade' && stopped !== 'server_too_old';
  if (h.detail === 'local_error') {
    return { key: 'local', heading: `Something went wrong on this device before the server could answer for ${w.these}.`, action: `${safe}${hint}`, retry, save: false };
  }
  if (h.status !== undefined) {
    return { key: 'busy', heading: `The server was busy or not available for ${w.these}.`, action: `${safe}${hint}`, retry, save: false };
  }
  // After a stop the last attempt never went out; an earlier one may have been answered, so "did not answer" would not be known to be true.
  if (stopped !== null) return { key: 'cut_short', heading: `Sending was cut short before the server replied for ${w.these}.`, action: `${safe}${hint}`, retry, save: false };
  return { key: 'no_answer', heading: `The server did not answer in time for ${w.these}.`, action: `${safe}${hint}`, retry, save: false };
}

function rejected(h: HeldBack): Template {
  if (h.code === 'PACKAGE_EXPIRED') {
    const d = days(positive(h.details?.maxAgeDays, PACKAGE_MAX_AGE_DAYS));
    return { key: 'file_expired', heading: `This file is more than ${d} old, so it cannot be imported.`, action: 'Your file was not changed. Make the file again on the device that holds the data.', retry: false, save: false };
  }
  if (h.code === 'PACKAGE_FROM_THE_FUTURE') {
    const d = days(positive(h.details?.maxFutureSkewDays, PACKAGE_MAX_FUTURE_SKEW_DAYS));
    return {
      key: 'file_future',
      heading: `This file is dated more than ${d} ahead of the server's clock, so the server said no.`,
      action: 'Check the date and time on the device that made it, then make the file again. Your file was not changed.',
      retry: false,
      save: false,
    };
  }
  if (h.status === 401 || h.status === 403) {
    return {
      key: 'file_session',
      heading: 'Your account may not be allowed to import, or you were signed out.',
      action: 'Sign in again, then choose Try again. If it keeps happening, check that the file came from this company.',
      retry: true,
      save: false,
    };
  }
  return { key: 'file_no', heading: 'The server said no to the whole file.', action: 'Your file was not changed. Make the file again from the app, or give it to whoever runs your server.', retry: false, save: false };
}

function saidNo(h: HeldBack, n: number): Template {
  const w = wordsFor(n);
  const keep = (key: string, heading: string, action: string, retry = false): Template => ({ key, heading, action, retry, save: true });
  switch (h.reason) {
    case 'not_found':
      return keep('not_found', `The server could not find ${w.them} in your company.`, `Check that ${w.them} ${n === 1 ? 'was' : 'were'} not removed. Save ${w.them} to keep ${w.them} until you know what to do.`);
    case 'forbidden':
      return keep('forbidden', `Your account is not allowed to change ${w.these}.`, `Ask an owner or manager who can open ${w.them} to import ${w.them}. You can save ${w.them} to give to that person.`);
    case 'different_report':
      return keep('different_report', `The report in the file is not the report ${w.these} ${n === 1 ? 'has' : 'have'} now.`, `Save ${w.them} and ask whoever made the file which report is current.`);
    case 'deleted':
      return keep('deleted', `${n === 1 ? 'This inspection was' : 'These were'} deleted after the file was made.`, `There is nothing to import for ${w.them}. Save ${w.them} only if you still need the data.`);
    case 'apply_failed':
      return keep('apply_failed', `The server could not save the data or a change for ${w.these}.`, `Try again later. If it keeps happening, save ${w.them} and give ${w.them} to whoever runs your server.`, true);
    case 'refused':
      return keep('refused', `The server said no to ${w.these} for a reason this app does not know.`, 'Update the app, then try again.');
    case 'too_large_to_split':
      return keep('too_large', n === 1 ? 'This inspection is too big to send in one go.' : 'These are each too big to send in one go.', `Save ${w.them} and make the file again from the device it came from, with fewer photos.`);
    case 'package_rejected':
      return rejected(h);
    case 'gave_up':
      return noAnswer(h, n, null, false);
  }
}

/** Which group an inspection belongs in, before the groups are counted (the wording depends on how many share it). */
function groupKey(h: HeldBack, outcome: ImportOutcome): string {
  if (h.reason === 'gave_up') {
    if (h.status === undefined && !outcome.requested.has(h.id) && outcome.stopped !== null) return `not_sent:${outcome.stopped}`;
    if (h.detail === 'local_error') return 'local';
    if (h.status !== undefined) return 'busy';
    return outcome.stopped === null ? 'no_answer' : 'cut_short';
  }
  if (h.reason === 'package_rejected') return rejected(h).key;
  return h.reason;
}

function templateFor(h: HeldBack, n: number, outcome: ImportOutcome, canSignIn: boolean): Template {
  if (h.reason === 'gave_up') {
    if (h.status === undefined && !outcome.requested.has(h.id) && outcome.stopped !== null) return notSent(outcome.stopped, n, canSignIn);
    return noAnswer(h, n, outcome.stopped, canSignIn);
  }
  return saidNo(h, n);
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** The cleaned address the file carried for an inspection, or null. Cleaned again here: this is the last step before the screen. */
const labelOf = (id: string, labels: ReadonlyMap<string, string>): string | null => cleanLabel(labels.get(id));

function buildGroups(outcome: ImportOutcome, labels: ReadonlyMap<string, string>, canSignIn: boolean): ResultGroup[] {
  const byKey = new Map<string, HeldBack[]>();
  for (const row of outcome.report.heldBack) {
    const key = groupKey(row, outcome);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey.entries()].map(([key, rows]) => {
    const first = rows[0];
    if (first === undefined) throw new Error('empty group');
    const t = templateFor(first, rows.length, outcome, canSignIn);
    return {
      key,
      heading: t.heading,
      action: t.action,
      rows: rows.map((row) => ({ ...row, name: labelOf(row.id, labels) ?? `Inspection ${stripBidi(row.id)}` })),
      retry: t.retry,
      save: t.save,
    };
  });
}

function headlineOf(imported: number, notImported: number, changes: number, allSkipped: boolean): string {
  const total = imported + notImported;
  if (total === 0) return 'This file has no inspections, so there was nothing to import.';
  if (notImported === 0) {
    if (allSkipped) return total === 1 ? 'The inspection was already imported. Nothing changed.' : `All ${String(total)} inspections were already imported. Nothing changed.`;
    const base = total === 1 ? 'The inspection was imported.' : `All ${String(total)} inspections were imported.`;
    return changes === 0 ? base : `${base} ${changes === 1 ? '1 change was' : `${String(changes)} changes were`} not applied.`;
  }
  if (imported === 0) return 'Nothing was imported.';
  return `${String(imported)} of ${String(total)} inspections ${imported === 1 ? 'was' : 'were'} imported. ${notImported === 1 ? '1 was' : `${String(notImported)} were`} not.`;
}

function detailsOf(outcome: ImportOutcome, labels: ReadonlyMap<string, string>): string[] {
  const { report, stopped } = outcome;
  const lines = [`Requests sent: ${String(report.requests)}`, `Imported: ${String(report.imported.length)}. Already on the server: ${String(report.skipped)}. Applied: ${String(report.applied)}.`];
  if (stopped !== null) lines.push(`Sending ended early: ${stopped}.`);
  for (const h of report.heldBack) {
    const answer = answerText(h);
    const extra = h.detail !== undefined && h.detail !== 'local_error' ? ` Server detail: ${stripBidi(h.detail)}.` : '';
    const label = labelOf(h.id, labels);
    lines.push(`${stripBidi(h.id)}${label === null ? '' : ` (${label})`}: ${h.reason}. Server answer: ${answer ?? 'none'}.${extra}`);
  }
  for (const c of report.needsAttention) {
    lines.push(`${stripBidi(c.op)} on inspection ${stripBidi(c.inspectionId)}: server answer ${String(c.status)}${c.reason === undefined ? '' : `, reason ${stripBidi(c.reason)}`}`);
  }
  return lines;
}

/**
 * `canSignIn`: the host can send the person to the sign-in screen. Only then, and only when the sign-in is what ended the import, the
 * main action is "Sign in again" ("Try again" would fail the same way). The other stops have no sign-in cure.
 */
export function buildResult(outcome: ImportOutcome, labels: ReadonlyMap<string, string> = NO_LABELS, canSignIn = false): ResultModel {
  const { report } = outcome;
  const groups = buildGroups(outcome, labels, canSignIn);
  const imported = report.imported.length;
  const notImported = report.heldBack.length;
  const changes = report.needsAttention.length;
  const allSkipped = imported > 0 && notImported === 0 && report.applied === 0 && report.skipped > 0 && changes === 0;
  const maybe = groups.filter((g) => ['no_answer', 'cut_short', 'busy', 'local'].includes(g.key)).reduce((sum, g) => sum + g.rows.length, 0);
  const absent = notImported - maybe;

  const meaning: string[] = [];
  if (notImported === 0 && changes === 0) meaning.push('Your file was not changed. Delete it when you no longer need it.');
  else {
    if (imported > 0) meaning.push(`Safe: ${plural(imported, 'inspection')} ${imported === 1 ? 'is' : 'are'} on the server now.`);
    if (maybe > 0) meaning.push(`${String(maybe)} may or may not be on the server.`);
    if (absent > 0) meaning.push(`${String(absent)} ${absent === 1 ? 'is' : 'are'} not on the server.`);
    if (changes > 0) meaning.push(`${plural(changes, 'change')} ${changes === 1 ? 'was' : 'were'} not applied (listed below).`);
    meaning.push('Your file and the inspections on this device were not changed.');
  }

  const saveIds = groups.filter((g) => g.save).flatMap((g) => g.rows.map((r) => r.id));
  const canRetry = groups.some((g) => g.retry);
  let primary: ResultModel['primary'];
  if (canSignIn && outcome.stopped === 'auth') primary = { kind: 'signin', label: 'Sign in again', ids: [] };
  else if (canRetry) primary = { kind: 'retry', label: 'Try again', ids: [] };
  else if (saveIds.length > 0) primary = { kind: 'save', label: `Save the ${String(saveIds.length)} that ${saveIds.length === 1 ? 'was' : 'were'} not imported`, ids: saveIds };
  else primary = { kind: 'done', label: 'Done', ids: [] };

  return {
    headline: headlineOf(imported, notImported, changes, allSkipped),
    meaning,
    primary,
    secondary: [{ kind: 'another', label: 'Import another file' }, ...(primary.kind === 'done' ? [] : [{ kind: 'done' as const, label: 'Done' }])],
    attention:
      changes === 0
        ? null
        : {
            heading: 'Some changes were not applied',
            intro: 'The inspections and photos arrived, but the server did not apply these changes, and they will not be sent again. Ask whoever runs your server if you need them.',
            rows: report.needsAttention.map((c) => `Change to ${labelOf(c.inspectionId, labels) ?? `inspection ${stripBidi(c.inspectionId)}`}`),
          },
    groups,
    details: detailsOf(outcome, labels),
  };
}

/** All the text a person reads on the result page, without the details. For checks on the wording. */
export function mainTextOf(model: ResultModel): string {
  return [
    model.headline,
    ...model.meaning,
    model.primary.label,
    ...model.secondary.map((s) => s.label),
    ...(model.attention === null ? [] : [model.attention.heading, model.attention.intro, ...model.attention.rows]),
    ...model.groups.flatMap((g) => [g.heading, g.action, ...g.rows.map((r) => r.name)]),
  ].join('\n');
}
