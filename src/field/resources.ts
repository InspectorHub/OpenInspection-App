import type { FieldResources } from '@inspectorhub/field-ui';
import { createCommentsLibrary, createCostItems, createPrefs, createRepairItems } from './resources-library';
import { createMediaPool, createSettingsSheet, createTemplateSearch } from './resources-media';
import { createAiAssist, createPublishReadiness, createVersionHistory } from './resources-misc';
import { createItemTags, type ItemTagsHooks } from './resources-tags';
import type { ResourceDeps } from './resources-shared';

export { DEFAULT_INSPECTION_PREFS } from './resources-library';
export type { ResourceDeps } from './resources-shared';

/**
 * Every optional member of `FieldDataSource.resources` except the video flow (`video-adapter.ts`). An absent member
 * hides its entry point in the editor, so each one is present; what a member answers without a connection is the
 * contract's own "nothing" (an empty list, null, `answered: false`) or the "needs a connection" sentence for a write.
 *
 * `itemTags` is the exception to "needs a connection": it works offline and tells the server when it can. Its type is the
 * package's own (field-ui 0.5), so a change to that shape fails the build here.
 */
export function createResources(deps: ResourceDeps, hooks: ItemTagsHooks = {}): Omit<Required<FieldResources>, 'video'> {
  return {
    itemTags: createItemTags(deps, hooks),
    prefs: createPrefs(deps),
    commentsLibrary: createCommentsLibrary(deps),
    costItems: createCostItems(deps),
    repairItems: createRepairItems(deps),
    mediaPool: createMediaPool(deps),
    settingsSheet: createSettingsSheet(deps),
    aiAssist: createAiAssist(deps),
    publishReadiness: createPublishReadiness(deps),
    templateSearch: createTemplateSearch(deps),
    versionHistory: createVersionHistory(deps),
  };
}
