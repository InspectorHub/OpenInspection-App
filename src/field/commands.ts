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
 *  - `save-settings` is queued as `inspection.update` when every key of the change is one the registry keeps. The
 *    registry drops every other key without a word, so a change with a key outside its list (a template, for one) must
 *    never reach it. Offline that change needs a connection. Online it is sent whole, unless an earlier write of the
 *    same inspection is still queued: sending past it would apply the writes out of order, so an eligible change is
 *    queued behind it and any other asks the person to try again.
 *  - Everything else needs a connection offline, and online goes straight to the `/api/*` route.
 *  - After an online write that succeeded, the cached copy the editor reloads from is refreshed (`afterWrite`), bounded
 *    in time. A refresh that cannot be done does not fail the write; it is reported through `onCacheStale`, because
 *    `CommandResult` is the package's fixed contract and has no place for it.
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
  /** The time stamped on an inspector signature. The assembler must pass a clock anchored to the server's. */
  signedAtMs(): number;
  /** True while this inspection has a write queued or stopped for a person (`hasQueuedWrites`). */
  hasQueuedWrites(inspectionId: string): Promise<boolean>;
  /** Refreshes the cached copy of this inspection (`createAfterWrite`). True when the cache now holds the server's state. */
  afterWrite(inspectionId: string): Promise<boolean>;
  /** The write succeeded but the cache could not be brought up to date: a reload will show the old state. */
  onCacheStale?(inspectionId: string): void;
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
  const eligible = keys.every((key) => UPDATE_FIELD_NAMES.includes(key));
  if (deps.isOnline()) {
    if (!(await deps.hasQueuedWrites(inspectionId))) return refreshed(deps, inspectionId, await saveSettingsOnline(deps.api, inspectionId, patch));
    return eligible ? queued(deps, 'inspection.update', { inspectionId, changes: patch }) : failure(MESSAGES.pendingChanges);
  }
  if (!eligible) return needsConnectionResult();
  return queued(deps, 'inspection.update', { inspectionId, changes: patch });
}

/** After a write that succeeded: bring the cache up to date, bounded, and never let that fail the write. */
async function refreshed(deps: CommandDeps, inspectionId: string, result: CommandResult<unknown>): Promise<CommandResult<unknown>> {
  if (!result.ok) return result;
  let fresh = false;
  try {
    fresh = await deps.afterWrite(inspectionId);
  } catch {
    fresh = false;
  }
  if (!fresh) {
    try {
      deps.onCacheStale?.(inspectionId);
    } catch {
      // A failing listener changes nothing about the write.
    }
  }
  return result;
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
      const sent = await executeOnline({ api: deps.api, signedAtMs: () => deps.signedAtMs() }, inspectionId, cmd, opts?.idempotencyKey);
      // A lookup writes nothing, so there is nothing for the cache to catch up with.
      return cmd.type === 'autofill-property-facts' ? sent : refreshed(deps, inspectionId, sent);
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
