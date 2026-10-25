import type { CommandData, CommandResult, ExecuteOptions, FieldCommand, ResultMap } from '@inspectorhub/field-ui';
import type { IsBlocked } from '../offline/blocked';
import { OutboxError } from '../offline/outbox';
import { RegistryError, UPDATE_FIELD_NAMES, isLocalId } from '../offline/registry';
import type { Api } from './api-client';
import { executeOnline, saveSettingsOnline } from './commands-online';
import { MESSAGES, blockedResult, failure, needsConnectionResult } from './messages';
import { sanitizeSettingsPatch } from './settings-patch';

/**
 * `FieldDataSource.execute`, routed. Where each command goes:
 *
 *  - `complete` is queued as `inspection.complete`, online or not: the replayer sends it when it can, and the editor
 *    data shows it as done meanwhile.
 *  - `load-scope` is answered from the downloaded results; it is a read of the device, not a request.
 *  - `save-settings` is queued as `inspection.update` ONLY while offline and ONLY when every key of the change is one
 *    the registry keeps. The registry drops every other key without a word, so a change with a key outside its list
 *    (a template, for one) must never reach it: that change needs a connection. Online it is sent whole.
 *  - Everything else needs a connection offline, and online goes straight to the `/api/*` route.
 *
 * A blocked inspection answers the blocked sentence and no request is made for it.
 */
export interface CommandDeps {
  isBlocked: IsBlocked;
  /** Link state, synchronously (`NetworkFlag.isOnline`). */
  isOnline(): boolean;
  /** Queues one write for the signed-in account (`OfflineStack.enqueue`). */
  enqueue(op: string, input: unknown): Promise<unknown>;
  api: Api;
  now(): number;
  /** The downloaded results of one scope (`load(id, scope)` of the editor data). */
  loadScope(inspectionId: string, scope: string): Promise<ResultMap>;
}

/** The commands that, when they cannot be sent, still answer with data the panel reads. */
function offlineAnswer(cmd: FieldCommand): CommandResult<unknown> {
  return cmd.type === 'autofill-property-facts' ? needsConnectionResult({ facts: null, reason: 'REQUEST_FAILED' }) : needsConnectionResult();
}

async function queued(deps: CommandDeps, op: string, input: unknown): Promise<CommandResult<unknown>> {
  try {
    await deps.enqueue(op, input);
    return { ok: true };
  } catch (error) {
    if (error instanceof RegistryError) return failure(MESSAGES.invalidValue);
    if (error instanceof OutboxError && error.code === 'blocked') return blockedResult();
    return failure(MESSAGES.notSaved);
  }
}

async function saveSettings(deps: CommandDeps, inspectionId: string, payload: Record<string, unknown>): Promise<CommandResult<unknown>> {
  const patch = sanitizeSettingsPatch(payload);
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: true };
  if (deps.isOnline()) return saveSettingsOnline(deps.api, inspectionId, patch);
  if (!keys.every((key) => UPDATE_FIELD_NAMES.includes(key))) return needsConnectionResult();
  return queued(deps, 'inspection.update', { inspectionId, changes: patch });
}

async function loadScope(deps: CommandDeps, inspectionId: string, scope: string): Promise<CommandResult<unknown>> {
  if (scope === '') return { ok: false };
  try {
    return { ok: true, data: { scope, results: await deps.loadScope(inspectionId, scope) } };
  } catch (error) {
    return failure(error instanceof Error && error.message !== '' ? error.message : MESSAGES.unavailable);
  }
}

async function route(deps: CommandDeps, inspectionId: string, cmd: FieldCommand, opts: ExecuteOptions | undefined): Promise<CommandResult<unknown>> {
  switch (cmd.type) {
    case 'complete':
      return queued(deps, 'inspection.complete', { inspectionId });
    case 'load-scope':
      return loadScope(deps, inspectionId, cmd.scope);
    case 'save-settings':
      return saveSettings(deps, inspectionId, cmd.payload);
    default: {
      if (!deps.isOnline()) return offlineAnswer(cmd);
      return executeOnline({ api: deps.api, now: () => deps.now() }, inspectionId, cmd, opts?.idempotencyKey);
    }
  }
}

export function createExecutor(deps: CommandDeps): <C extends FieldCommand>(inspectionId: string, cmd: C, opts?: ExecuteOptions) => Promise<CommandResult<CommandData<C>>> {
  // The result's `data` is typed per command by the package; every branch above builds exactly that shape.
  return async <C extends FieldCommand>(inspectionId: string, cmd: C, opts?: ExecuteOptions): Promise<CommandResult<CommandData<C>>> => {
    const result = await decide(deps, inspectionId, cmd, opts);
    return result as CommandResult<CommandData<C>>;
  };
}

async function decide(deps: CommandDeps, inspectionId: string, cmd: FieldCommand, opts: ExecuteOptions | undefined): Promise<CommandResult<unknown>> {
  if (!isLocalId(inspectionId)) return failure(MESSAGES.unavailable);
  if (await deps.isBlocked(inspectionId)) return blockedResult();
  try {
    return await route(deps, inspectionId, cmd, opts);
  } catch (error) {
    if (error instanceof RangeError) return failure(MESSAGES.unavailable);
    return failure(MESSAGES.requestFailed);
  }
}
