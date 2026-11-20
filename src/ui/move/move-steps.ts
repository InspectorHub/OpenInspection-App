/**
 * The guided "move" flow has no engine API of its own: it strings together the
 * export and import panels that already own the step-up, progress and undo
 * contracts. These are the step definitions and the derived checklists.
 *
 * Public, Electron-only, English only. No internal task codes or private
 * policy in anything rendered here.
 */

/** The five classes a package can exclude, mirrored from the format package's
 * manifest schema. Asserting against this list (not a free-form string) keeps
 * the "what does not move" checklist honest when the format grows. */
export const EXCLUDED_CLASSES = [
  'withheld_secret', 'out_of_scope', 'unclassified_column', 'external_media', 'mode_bound',
] as const;
export type ExcludedClass = (typeof EXCLUDED_CLASSES)[number];

export interface ExcludedItem {
  readonly class: string;
  readonly table: string;
  readonly reason: string;
}

/** Plain-language meaning of each exclusion class. One entry per class; a class
 *  with no copy is a bug, caught by the unit test. */
export const EXCLUDED_COPY: Readonly<Record<ExcludedClass, string>> = {
  withheld_secret: 'Credentials and secrets were left out and must be set up again.',
  out_of_scope: 'Some records are not part of a data package and were left out.',
  unclassified_column: 'A few fields could not be classified and were left out.',
  external_media: 'Media held by an external provider was left out.',
  mode_bound: 'Settings tied to the source plan were left out.',
};

/** The services a reconnected workspace may need to set up again. Kept as a
 *  fixed list so the checklist never drifts from what the product supports. */
export const RECONNECT_ITEMS = [
  'Accounting integrations',
  'Calendar connections',
  'SMS and phone registration',
  'Email provider',
  'Your domain and forwarding',
  'Re-invite your team',
] as const;

export interface MoveStep {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** Optional steps are shown but not required (e.g. the freeze step while
   *  self-service freeze is not available). */
  readonly optional?: boolean;
}

/** Leaving a hosted workspace: make a package, verify it, note what will not
 *  move, then finish on the new deployment. */
export const LEAVE_STEPS: readonly MoveStep[] = [
  { id: 'understand', title: 'Before you start', body: 'You will copy this company into a data package that you keep on this computer. The original stays here until you choose to delete it.' },
  { id: 'prepare', title: 'Prepare', body: 'Check that you are the owner and that you can sign in on the new deployment before you begin.' },
  { id: 'freeze', title: 'Pause changes', body: 'Ask support to make this workspace read-only while you move, so the package matches what you reviewed.', optional: true },
  { id: 'export', title: 'Make the package', body: 'Create the package on this computer and save it somewhere safe. It contains your clients’ information in plaintext.' },
  { id: 'verify', title: 'Check the package', body: 'Verify the package before you leave this page, so a damaged copy is caught here rather than after you delete the original.' },
  { id: 'links', title: 'What will not move', body: 'Review the items that are not in the package and the services you will reconnect on the new deployment.' },
  { id: 'finish', title: 'Finish', body: 'Sign in on the new deployment and follow the arrival steps with this package.' },
];

/** Arriving at a self-hosted deployment: open a package, verify and import it,
 *  then work through the reconnect checklist. */
export const ARRIVE_STEPS: readonly MoveStep[] = [
  { id: 'choose', title: 'Choose a package', body: 'Pick the data package you made on the old workspace.' },
  { id: 'verify', title: 'Check the package', body: 'The file is verified on this computer before anything is sent to the server.' },
  { id: 'import', title: 'Restore', body: 'Import the package. Undoing an import permanently deletes everything it created, including any edits made afterwards.' },
  { id: 'checklist', title: 'Reconnect', body: 'Restore the services and settings that a package cannot carry across.' },
];

/** Group excluded items by class for display. Only classes present in the
 *  package appear, and each is the authoritative class name. */
export function groupExcluded(items: readonly ExcludedItem[]): { cls: ExcludedClass; items: readonly ExcludedItem[] }[] {
  const byClass = new Map<ExcludedClass, ExcludedItem[]>();
  for (const item of items) {
    if (!isExcludedClass(item.class)) continue;
    const list = byClass.get(item.class) ?? [];
    list.push(item);
    byClass.set(item.class, list);
  }
  return EXCLUDED_CLASSES
    .filter((cls) => byClass.has(cls))
    .map((cls) => ({ cls, items: byClass.get(cls)! }));
}

export function isExcludedClass(value: string): value is ExcludedClass {
  return (EXCLUDED_CLASSES as readonly string[]).includes(value);
}
