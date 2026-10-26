import type { CommandResult, FieldResources, MediaPoolListing, SettingsSheetData } from '@inspectorhub/field-ui';
import type { IsBlocked } from '../offline/blocked';
import { accountKey, type Account } from '../offline/outbox';
import { readCached } from '../offline/resource-cache';
import type { Db } from '../platform/db';
import type { Api, ApiCall } from './api-client';
import { isRec, isSuccess, problemResult } from './commands-shared';
import { MESSAGES, failureOf } from './messages';

/**
 * What the editor's resource members (`FieldDataSource.resources`) are built from. Where the web editor asks its own
 * server, which asks the API, the app asks the API directly with its Bearer token; offline, a read answers what the
 * contract's empty answer is (nothing is hidden, nothing throws) and a write answers the "needs a connection" sentence.
 */
export interface ResourceDeps {
  api: Api;
  db: Db;
  account: Account;
  /** Link state, synchronously. */
  isOnline(): boolean;
  isBlocked: IsBlocked;
  /** `urls.photo`: the address a photo key is shown from. */
  photoUrl(inspectionId: string, key: string): string;
  /** Refreshes the cached copy of an inspection after a write (`createAfterWrite`). Never rejects. */
  afterWrite?(inspectionId: string): Promise<boolean>;
}

/** The parsed body of a request that succeeded, or null for anything else (a problem, a refusal, a name that cannot be a path). */
export async function readBody(api: Api, call: ApiCall): Promise<{ json: unknown } | null> {
  try {
    const outcome = await api.send(call);
    return outcome.kind === 'response' && isSuccess(outcome.status) ? { json: outcome.json } : null;
  } catch {
    return null;
  }
}

/** The `data` of a cached read of this account, or undefined when it is absent or unreadable. */
export async function cachedData(deps: Pick<ResourceDeps, 'db' | 'account'>, path: string): Promise<unknown> {
  try {
    const cached = await readCached(deps.db, accountKey(deps.account), path);
    if (cached === null) return undefined;
    const parsed: unknown = JSON.parse(cached.body);
    return isRec(parsed) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The sentence for a write whose request ended without a success answer. */
export function writeFailure(outcome: Awaited<ReturnType<Api['send']>>, fallback: string): CommandResult<never> {
  if (outcome.kind === 'problem') return failureOf(problemResult(outcome.problem).error ?? fallback);
  if (outcome.status === 403) return failureOf(MESSAGES.forbidden);
  return failureOf(fallback);
}

export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The package exports the listing types but not their elements; these are the same types, named. */
export type GalleryPhoto = MediaPoolListing['photos'][number];
export type CoverPhotoOption = SettingsSheetData['photos'][number];
export type PublishReadiness = NonNullable<Awaited<ReturnType<NonNullable<FieldResources['publishReadiness']>['check']>>>;
