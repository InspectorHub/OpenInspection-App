import { apiPath, type Api } from './api-client';
import { isSuccess, problemResult, serverMessage } from './commands-shared';
import { MESSAGES } from './messages';

export type ReopenOutcome =
  /** The server opened the report for editing. `cacheCurrent` is false when this device could not download the new state yet. */
  | { ok: true; cacheCurrent: boolean }
  | { ok: false; error: string };

export interface ReopenDeps {
  api: Api;
  isOnline(): boolean;
  /** Downloads the inspection again after an online write; answers whether the cache now holds the server's state. */
  afterWrite(inspectionId: string): Promise<boolean>;
}

/**
 * "Edit and republish": a published report takes no edit until the inspector opens it again, and only the server can open it.
 * Clients keep reading the latest version meanwhile, nothing is sent and no link ends. The call can be repeated: a report that is
 * already open for editing answers the same.
 */
export async function reopenReport(deps: ReopenDeps, inspectionId: string): Promise<ReopenOutcome> {
  if (!deps.isOnline()) return { ok: false, error: MESSAGES.needsConnection };
  const res = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'edit-again'), json: {} });
  if (res.kind === 'problem') {
    const failed = problemResult(res.problem, MESSAGES.reopenFailed);
    return { ok: false, error: failed.error ?? MESSAGES.reopenFailed };
  }
  if (!isSuccess(res.status)) return { ok: false, error: serverMessage(res.json) ?? (res.status === 403 ? MESSAGES.forbidden : MESSAGES.reopenFailed) };
  return { ok: true, cacheCurrent: await deps.afterWrite(inspectionId) };
}
