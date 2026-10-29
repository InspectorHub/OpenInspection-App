import type { CommandResult, FieldCommand } from '@inspectorhub/field-ui';
import { apiPath, templatePath, type Api } from './api-client';
import { executeCompliance, executeUnit } from './commands-online-units';
import { bodyData, isRec, isSuccess, plain, problemResult, serverMessage } from './commands-shared';
import { MESSAGES, failure, needsConnectionResult } from './messages';

/**
 * The online form of the editor's commands: each one is the request (or the short sequence of requests) the web
 * editor's action makes (`app/routes/inspection-edit/action.server.ts` and the two modules it chains to), sent
 * straight to the `/api/*` route with the app's Bearer token instead of through the web server's relay. Inputs the web
 * action refuses are refused here without a request.
 */

/** The commands this module answers. The others are decided before the network: queued, or read from the cache. */
export type OnlineCommand = Exclude<FieldCommand, { type: 'complete' | 'load-scope' | 'save-settings' }>;

export interface OnlineDeps {
  api: Api;
  /**
   * Milliseconds since the epoch, stamped on an inspector signature as the time it was signed. The assembler must pass
   * a clock anchored to the server's (the device clock can be set to any time); until it does, this is only as honest as
   * the device.
   */
  signedAtMs(): number;
}

function never(value: never): never {
  throw new Error(`unhandled command ${JSON.stringify(value)}`);
}

/** A request body part. The platform sets the multipart content type, so a file keeps its own name or gets the fallback. */
function appendFile(form: FormData, field: string, blob: Blob, fallbackName: string): void {
  form.append(field, blob, blob instanceof File && blob.name !== '' ? blob.name : fallbackName);
}

async function publish(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'publish' }>, key: string | undefined): Promise<CommandResult<unknown>> {
  // Completing first is advisory and never a gate: a failure there does not stop the publish.
  if (cmd.markComplete === true) await deps.api.send({ method: 'POST', path: apiPath(id, 'complete') });
  // The sign flag is set BEFORE the publish and must have landed: the publish decides whether to sign by re-reading it,
  // so publishing past a failed write would send the report out signed or unsigned against what the person chose.
  if (cmd.autoSignOnPublish !== undefined) {
    const flag = await deps.api.send({ method: 'PATCH', path: apiPath(id), json: { autoSignOnPublish: cmd.autoSignOnPublish } });
    if (flag.kind === 'problem' || !isSuccess(flag.status)) return flag.kind === 'problem' ? problemResult(flag.problem, MESSAGES.publishOutcomeUnknown) : failure(MESSAGES.requestFailed);
  }
  const summary = (cmd.summary ?? '').trim();
  const res = await deps.api.send({ method: 'POST', path: apiPath(id, 'publish'), json: summary === '' ? {} : { summary }, ...(key === undefined ? {} : { idempotencyKey: key }) });
  if (res.kind === 'problem') return problemResult(res.problem, MESSAGES.publishOutcomeUnknown);
  if (isSuccess(res.status)) return { ok: true };
  // A precondition failure ("must be completed before publishing") is something the inspector has to read.
  return failure(serverMessage(res.json) ?? (res.status === 403 ? MESSAGES.forbidden : MESSAGES.publishFailed));
}

async function autofill(deps: OnlineDeps, id: string, addressString: string): Promise<CommandResult<unknown>> {
  const address = addressString.trim();
  if (address.length < 5) return { ok: false, data: { facts: null, reason: 'BAD_ADDRESS' } };
  const res = await deps.api.send({ method: 'POST', path: apiPath(id, 'property-facts', 'autofill'), json: { addressString: address } });
  // The lookup persists nothing, so a lost answer costs nothing: it reads as needing a connection.
  if (res.kind === 'problem') return res.problem === 'offline' || res.problem === 'unknown' ? needsConnectionResult({ facts: null, reason: 'REQUEST_FAILED' }) : { ...problemResult(res.problem), data: { facts: null, reason: 'REQUEST_FAILED' } };
  if (!isSuccess(res.status)) return { ok: false, data: { facts: null, reason: 'REQUEST_FAILED' } };
  const data = bodyData(res.json);
  return { ok: true, data: { facts: isRec(data?.facts) ? data.facts : null, reason: typeof data?.reason === 'string' ? data.reason : null } };
}

async function uploadCover(deps: OnlineDeps, id: string, file: Blob, key: string | undefined): Promise<CommandResult<unknown>> {
  const form = new FormData();
  appendFile(form, 'file', file, 'cover.jpg');
  const up = await deps.api.send({ method: 'POST', path: apiPath(id, 'media', 'upload'), form, ...(key === undefined ? {} : { idempotencyKey: key }) });
  if (up.kind === 'problem' || !isSuccess(up.status)) return plain(up);
  const uploaded = bodyData(up.json);
  const coverKey = typeof uploaded?.key === 'string' && uploaded.key !== '' ? uploaded.key : undefined;
  if (coverKey === undefined) return failure(MESSAGES.unreadableAnswer);
  const patched = plain(await deps.api.send({ method: 'PATCH', path: apiPath(id), json: { coverPhotoId: coverKey } }));
  return patched.ok ? { ok: true, data: { coverKey, coverUrl: typeof uploaded?.url === 'string' ? uploaded.url : null } } : patched;
}

async function cropCover(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'crop-cover' }>): Promise<CommandResult<unknown>> {
  if (cmd.sourceKey === '') return { ok: false };
  const form = new FormData();
  appendFile(form, 'image', cmd.image, 'cover.jpg');
  form.append('sourceKey', cmd.sourceKey);
  form.append('crop', cmd.crop);
  const res = await deps.api.send({ method: 'POST', path: apiPath(id, 'cover'), form });
  const result = plain(res);
  if (!result.ok || res.kind !== 'response') return result;
  const coverKey = bodyData(res.json)?.coverImageKey;
  return { ok: true, data: { coverKey: typeof coverKey === 'string' && coverKey !== '' ? coverKey : null } };
}

async function annotate(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'annotate' }>): Promise<CommandResult<unknown>> {
  if (cmd.itemId === '' || !Number.isInteger(cmd.photoIndex) || cmd.photoIndex < 0) return { ok: false };
  const form = new FormData();
  appendFile(form, 'image', cmd.image, 'annotation.png');
  form.append('nodes', cmd.nodes);
  if (cmd.sectionId) form.append('sectionId', cmd.sectionId);
  return plain(await deps.api.send({ method: 'POST', path: apiPath(id, 'items', cmd.itemId, 'photos', String(cmd.photoIndex), 'annotation'), form }));
}

async function restructure(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'restructure' }>): Promise<CommandResult<unknown>> {
  // The web action does not look at this answer, so a refused snapshot reads as saved there. Here it is a failure.
  const saved = await deps.api.send({ method: 'PATCH', path: apiPath(id, 'template-snapshot'), json: { snapshot: cmd.snapshot } });
  if (saved.kind === 'problem' || !isSuccess(saved.status)) return saved.kind === 'problem' ? problemResult(saved.problem) : failure(MESSAGES.structureNotSaved);
  if (!cmd.collab) return { ok: true };
  const sync = await deps.api.send({ method: 'POST', path: apiPath(id, 'collab', 'restructure') });
  // 501 is collaboration switched off (a single client): nothing to converge. Anything else that is not a success,
  // including a step that could not be completed at all, leaves live sessions on the old structure.
  if (sync.kind === 'problem') return failure(MESSAGES.syncNotConverged);
  if (!isSuccess(sync.status) && sync.status !== 501) return failure(MESSAGES.syncNotConverged);
  return { ok: true };
}

async function saveStructureTemplate(deps: OnlineDeps, cmd: Extract<FieldCommand, { type: 'save-structure-template' }>): Promise<CommandResult<unknown>> {
  if (cmd.mode === 'new') {
    return plain(await deps.api.send({ method: 'POST', path: templatePath(), json: { name: cmd.name?.trim() || 'Custom Template', schema: cmd.snapshot } }));
  }
  if (cmd.templateId === '') return failure(MESSAGES.noSourceTemplate);
  const path = templatePath(cmd.templateId);
  const found = await deps.api.send({ method: 'GET', path });
  if (found.kind === 'problem') return problemResult(found.problem);
  if (!isSuccess(found.status)) return failure(MESSAGES.sourceTemplateUnreadable);
  const template = bodyData(found.json)?.template;
  const name = isRec(template) ? template.name : undefined;
  // Without the name the PUT would rename the source template; failing is the safe side.
  if (typeof name !== 'string' || name.trim() === '') return failure(MESSAGES.sourceTemplateUnnamed);
  return plain(await deps.api.send({ method: 'PUT', path, json: { name: name.trim(), schema: cmd.snapshot } }));
}

async function setFollowup(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'set-followup' }>): Promise<CommandResult<unknown>> {
  if (cmd.itemId === '') return failure(MESSAGES.missingItem);
  const status = cmd.status !== null && cmd.status !== '' ? cmd.status : null;
  const res = await deps.api.send({ method: 'POST', path: apiPath(id, 'collab', 'followup'), json: cmd.notes === undefined ? { itemId: cmd.itemId, status } : { itemId: cmd.itemId, status, notes: cmd.notes } });
  if (res.kind === 'problem') return problemResult(res.problem);
  if (isSuccess(res.status)) return { ok: true };
  // 501 is collaboration switched off: the field is unavailable here, not momentarily failing.
  if (res.status === 501) return failure(MESSAGES.followupNeedsLiveEditing);
  if (isRec(res.json) && res.json.reason === 'ambiguous') return failure(MESSAGES.followupAmbiguous);
  return failure(serverMessage(res.json) ?? MESSAGES.followupNotSaved);
}

async function addStatutoryInstance(deps: OnlineDeps, id: string, cmd: Extract<FieldCommand, { type: 'add-statutory-instance' }>, key: string | undefined): Promise<CommandResult<unknown>> {
  const res = await deps.api.send({
    method: 'POST',
    path: apiPath(id, 'statutory-form', 'instances'),
    json: { groupId: cmd.groupId, index: cmd.index, fields: cmd.fields },
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
  const result = plain(res, true);
  // The one refusal this raises names a slot the form prints, which the person needs to read.
  return !result.ok && result.error === undefined && res.kind === 'response' ? failure(MESSAGES.instanceNotRecorded) : result;
}

/** Saves the settings sheet's change. The patch is already sanitised; an empty one is the caller's no-op. */
export async function saveSettingsOnline(api: Api, id: string, patch: Record<string, unknown>): Promise<CommandResult<unknown>> {
  return plain(await api.send({ method: 'PATCH', path: apiPath(id), json: patch }));
}

async function route(deps: OnlineDeps, id: string, cmd: OnlineCommand, idempotencyKey: string | undefined): Promise<CommandResult<unknown>> {
  const { api } = deps;
  switch (cmd.type) {
    case 'publish':
      return publish(deps, id, cmd, idempotencyKey);
    case 'save-property-facts':
      return plain(await api.send({ method: 'PATCH', path: apiPath(id, 'property-facts'), json: cmd.payload }));
    case 'autofill-property-facts':
      return autofill(deps, id, cmd.addressString);
    case 'save-pca-narrative':
      if (cmd.key === '') return { ok: false };
      return plain(await api.send({ method: 'PATCH', path: apiPath(id, 'pca-narrative'), json: { [cmd.key]: cmd.value } }));
    case 'sign-inspector':
      // An empty signature is a no-op that still answers ok (the contract says so).
      if (cmd.signatureBase64 === '') return { ok: true };
      return plain(await api.send({ method: 'POST', path: apiPath(id, 'inspector-signature'), json: { signatureBase64: cmd.signatureBase64, signedAt: deps.signedAtMs() } }));
    case 'set-cover':
      return plain(await api.send({ method: 'PATCH', path: apiPath(id), json: { coverPhotoId: cmd.coverPhotoId === '' ? null : cmd.coverPhotoId } }));
    case 'upload-cover':
      return uploadCover(deps, id, cmd.file, idempotencyKey);
    case 'crop-cover':
      return cropCover(deps, id, cmd);
    case 'annotate':
      return annotate(deps, id, cmd);
    case 'restructure':
      return restructure(deps, id, cmd);
    case 'save-structure-template':
      return saveStructureTemplate(deps, cmd);
    case 'add-statutory-instance':
      return addStatutoryInstance(deps, id, cmd, idempotencyKey);
    case 'save-statutory-details':
      return plain(await api.send({ method: 'PATCH', path: apiPath(id, 'statutory-details'), json: cmd.payload }));
    case 'set-followup':
      return setFollowup(deps, id, cmd);
    case 'unit':
      return executeUnit(api, id, cmd, idempotencyKey);
    case 'compliance':
      return executeCompliance(api, id, cmd);
    default:
      return never(cmd);
  }
}

export async function executeOnline(deps: OnlineDeps, id: string, cmd: OnlineCommand, idempotencyKey: string | undefined): Promise<CommandResult<unknown>> {
  try {
    return await route(deps, id, cmd, idempotencyKey);
  } catch (error) {
    // A name that cannot be a path segment (an item or template id that resolves away): refused before any request.
    if (error instanceof RangeError) return failure(MESSAGES.invalidValue);
    throw error;
  }
}
