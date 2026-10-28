import type { CommandResult } from '@inspectorhub/field-ui';
import { accountKey } from '../offline/outbox';
import { isRec } from './commands-shared';
import { addTag, readTags, removeTag, type TagInfo, type TagMap } from './item-tags-store';
import { createItemTagSync, type ItemTagSync } from './item-tags-sync';
import { MESSAGES, blockedOf, failureOf } from './messages';
import { cachedData, type ResourceDeps } from './resources-shared';

/**
 * The editor's `resources.itemTags` (field-ui 0.5.0). `createResources` returns it typed as the package's own member, so
 * this interface has to stay assignable to it.
 *
 * Offline-first: a toggle is written to the device at once and answers ok, and the server is told when it can be
 * (`item-tags-sync.ts`). `list` also sends what the server has not heard yet and then reads what it has, so what a person
 * sees is the server's answer with their own unsent changes on top.
 */
export interface ItemTagsStore {
  list(inspectionId: string): Promise<TagMap | null>;
  add(inspectionId: string, itemId: string, tagId: string): Promise<CommandResult>;
  remove(inspectionId: string, itemId: string, tagId: string): Promise<CommandResult>;
}

export interface ItemTagsHooks {
  /** The server refused some changes for good and they were undone on the device. */
  onRejected?(count: number): void;
  now?(): number;
}

/** An id the editor hands over is one name; this bounds what can be stored for a bug or a hostile caller. */
const isStorableId = (id: string): boolean => id.length >= 1 && id.length <= 128 && ![...id].some((ch) => ch.charCodeAt(0) < 32);

/** The name and colour of a tag from the library the app already holds, or what is known of it when the library lacks it. */
async function describeTag(deps: ResourceDeps, tagId: string): Promise<TagInfo> {
  const library = await cachedData(deps, '/api/tags');
  if (Array.isArray(library)) {
    for (const entry of library) {
      if (isRec(entry) && entry.id === tagId && typeof entry.name === 'string') {
        return { id: tagId, name: entry.name, ...(typeof entry.color === 'string' ? { color: entry.color } : {}) };
      }
    }
  }
  // A tag the cached library does not list: shown by its id until the server's answer (a read) names it.
  return { id: tagId, name: tagId };
}

export function createItemTags(deps: ResourceDeps, hooks: ItemTagsHooks = {}): ItemTagsStore & { readonly sync: ItemTagSync } {
  const account = accountKey(deps.account);
  const now = hooks.now ?? (() => Date.now());
  const sync = createItemTagSync({
    api: deps.api,
    db: deps.db,
    account: deps.account,
    isOnline: deps.isOnline,
    isBlocked: deps.isBlocked,
    now,
    ...(hooks.onRejected === undefined ? {} : { onRejected: hooks.onRejected }),
  });

  const valid = (...ids: string[]): boolean => ids.every(isStorableId);

  async function change(inspectionId: string, itemId: string, tagId: string, adding: boolean): Promise<CommandResult> {
    try {
      if (!valid(inspectionId, itemId, tagId)) return failureOf(MESSAGES.invalidValue);
      if (await deps.isBlocked(inspectionId)) return blockedOf();
      if (adding) await addTag(deps.db, account, inspectionId, itemId, await describeTag(deps, tagId), now());
      else await removeTag(deps.db, account, inspectionId, itemId, tagId, now());
      // Told to the server when there is a way to; never waited for, and never allowed to fail the toggle.
      if (deps.isOnline()) void sync.flush();
      return { ok: true };
    } catch {
      return failureOf(MESSAGES.notSaved);
    }
  }

  return {
    sync,
    list: async (inspectionId) => {
      try {
        if (!valid(inspectionId) || (await deps.isBlocked(inspectionId))) return null;
        if (deps.isOnline()) {
          // Every inspection's unsent changes go first (this is the moment the device is known to be online and a person is
          // here), then this inspection's tags are read with their own unsent changes kept on top.
          await sync.flush();
          await sync.pull(inspectionId);
        }
        return await readTags(deps.db, account, inspectionId);
      } catch {
        return null;
      }
    },
    add: (inspectionId, itemId, tagId) => change(inspectionId, itemId, tagId, true),
    remove: (inspectionId, itemId, tagId) => change(inspectionId, itemId, tagId, false),
  };
}
