import type { AiAssistInput, AiAssistResult, CommandResult, FieldResources, VersionSnapshotContent, VersionSnapshotEntry } from '@inspectorhub/field-ui';
import { apiPath } from './api-client';
import { bodyData, isRec, isSuccess, problemResult, serverMessage } from './commands-shared';
import { MESSAGES, blockedOf, failureOf, needsConnectionResult } from './messages';
import { asList, readBody, writeFailure, type PublishReadiness, type ResourceDeps } from './resources-shared';

/**
 * The online-only members: the publish pre-flight, the stored versions of the report content, and AI writing
 * assistance. Offline, a read answers its "could not read" shape and a write answers the "needs a connection" sentence;
 * none of them rejects.
 */

function readiness(json: unknown): PublishReadiness | null {
  if (!isRec(json) || typeof json.ready !== 'boolean' || !Array.isArray(json.blockingDefects)) return null;
  const verdict: PublishReadiness = { ready: json.ready, blockingDefects: json.blockingDefects as PublishReadiness['blockingDefects'] };
  if (Array.isArray(json.warningDefects)) verdict.warningDefects = json.warningDefects as PublishReadiness['blockingDefects'];
  return verdict;
}

export function createPublishReadiness(deps: ResourceDeps): NonNullable<FieldResources['publishReadiness']> {
  return {
    // A check that cannot be made is null, and the editor goes on to the publish dialog: a flaky pre-flight must not block publishing.
    check: async (inspectionId) => {
      try {
        if (!deps.isOnline() || (await deps.isBlocked(inspectionId))) return null;
        const body = await readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'publish-readiness') });
        return body === null ? null : readiness(body.json);
      } catch {
        return null;
      }
    },
  };
}

function snapshotEntries(value: unknown): VersionSnapshotEntry[] {
  const out: VersionSnapshotEntry[] = [];
  for (const entry of asList(value)) {
    if (!isRec(entry) || typeof entry.seq !== 'number' || typeof entry.atMs !== 'number') continue;
    const snap: VersionSnapshotEntry = { seq: entry.seq, atMs: entry.atMs, byUserId: typeof entry.byUserId === 'string' ? entry.byUserId : null };
    if (entry.reason === 'periodic' || entry.reason === 'manual' || entry.reason === 'connect') snap.reason = entry.reason;
    out.push(snap);
  }
  return out;
}

export function createVersionHistory(deps: ResourceDeps): NonNullable<FieldResources['versionHistory']> {
  /** Runs a request for one inspection; a blocked one, no connection and a bad name each answer without a request. */
  async function guarded<T>(inspectionId: string, work: () => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
    try {
      if (await deps.isBlocked(inspectionId)) return blockedOf();
      if (!deps.isOnline()) return needsConnectionResult();
      return await work();
    } catch (error) {
      return failureOf(error instanceof RangeError ? MESSAGES.invalidValue : MESSAGES.requestFailed);
    }
  }
  return {
    list: (inspectionId) =>
      guarded(inspectionId, async () => {
        const body = await readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'collab', 'snapshots') });
        return body === null ? failureOf(MESSAGES.requestFailed) : { ok: true, data: snapshotEntries(body.json) };
      }),
    get: (inspectionId, seq) =>
      guarded(inspectionId, async () => {
        if (!Number.isInteger(seq) || seq < 0) return failureOf(MESSAGES.invalidValue);
        const body = await readBody(deps.api, { method: 'GET', path: apiPath(inspectionId, 'collab', 'snapshots', String(seq)) });
        const projection = body !== null && isRec(body.json) ? body.json.projection : undefined;
        return isRec(projection) ? { ok: true, data: { projection: projection as VersionSnapshotContent['projection'] } } : failureOf(MESSAGES.requestFailed);
      }),
    restore: (inspectionId, seq) =>
      guarded(inspectionId, async () => {
        if (!Number.isInteger(seq) || seq < 0) return failureOf(MESSAGES.invalidValue);
        const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'collab', 'restore'), json: { seq } });
        if (outcome.kind === 'response' && isSuccess(outcome.status)) return { ok: true };
        if (outcome.kind === 'response') return failureOf(serverMessage(outcome.json) ?? MESSAGES.requestFailed);
        return failureOf(problemResult(outcome.problem).error ?? MESSAGES.requestFailed);
      }),
    capture: (inspectionId) =>
      guarded(inspectionId, async () => {
        const outcome = await deps.api.send({ method: 'POST', path: apiPath(inspectionId, 'collab', 'snapshots') });
        return outcome.kind === 'response' && isSuccess(outcome.status) ? { ok: true } : writeFailure(outcome, MESSAGES.requestFailed);
      }),
  };
}

const unavailable = (error: string = MESSAGES.aiUnavailable): AiAssistResult => ({ ok: false, error });

export function createAiAssist(deps: ResourceDeps): NonNullable<FieldResources['aiAssist']> {
  async function assist(input: Extract<AiAssistInput, { intent: 'assist' }>): Promise<AiAssistResult> {
    const body = input.payload.text.trim();
    if (body === '') return unavailable();
    const context = (input.payload.context ?? '').trim();
    const outcome = await deps.api.send({ method: 'POST', path: '/api/ai/comment-assist', json: { text: body, ...(context === '' ? {} : { context }) } });
    if (outcome.kind === 'problem') return unavailable(problemResult(outcome.problem).error);
    if (!isSuccess(outcome.status)) return unavailable(serverMessage(outcome.json));
    const data = bodyData(outcome.json);
    // Both or neither: a suggestion without its call id could never be reviewed, so it is not offered.
    return typeof data?.text === 'string' && data.text !== '' && typeof data.aiCallId === 'string' && data.aiCallId !== ''
      ? { ok: true, intent: 'assist', text: data.text, aiCallId: data.aiCallId }
      : unavailable();
  }

  async function review(input: Extract<AiAssistInput, { intent: 'review' }>): Promise<AiAssistResult> {
    const artifactId = input.payload.artifactId.trim();
    const aiCallId = input.payload.aiCallId.trim();
    if (artifactId === '' || aiCallId === '') return unavailable();
    const outcome = await deps.api.send({ method: 'POST', path: '/api/ai/reviews', json: { artifactType: 'inspection_result', artifactId, aiCallId } });
    // The review is what lets assisted text into a note: only a success answer counts.
    if (outcome.kind === 'problem') return unavailable(problemResult(outcome.problem).error);
    return isSuccess(outcome.status) ? { ok: true, intent: 'review' } : unavailable(serverMessage(outcome.json));
  }

  return {
    run: async (input) => {
      if (!deps.isOnline()) return unavailable(MESSAGES.needsConnection);
      try {
        return input.intent === 'assist' ? await assist(input) : await review(input);
      } catch {
        return unavailable();
      }
    },
  };
}
