import type { CommandResult } from '@inspectorhub/field-ui';
import type { ApiOutcome, ApiProblem } from './api-client';
import { MESSAGES, failure, needsConnectionResult } from './messages';

export type Rec = Record<string, unknown>;

export const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** The error code the API's idempotency middleware answers with (HTTP 409) for a repeat that arrives while the first is still running. */
const IN_FLIGHT_CODE = 'IDEMPOTENCY_IN_FLIGHT';

export function problemResult(problem: ApiProblem): CommandResult<unknown> {
  switch (problem) {
    case 'offline':
      return needsConnectionResult();
    case 'timeout':
      return failure(MESSAGES.timedOut);
    case 'upgrade':
      return failure(MESSAGES.upgradeRequired);
    case 'auth':
      return failure(MESSAGES.sessionExpired);
  }
}

/** The sentence the server wrote for a refusal, if it wrote one in a shape this reads. Never the raw body. */
export function serverMessage(json: unknown): string | undefined {
  if (!isRec(json)) return undefined;
  const { error, message } = json;
  if (typeof error === 'string' && error !== '') return error;
  if (isRec(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof message === 'string' && message !== '') return message;
  return undefined;
}

/** The `data` of a success envelope, or undefined. */
export function bodyData(json: unknown): Rec | undefined {
  return isRec(json) && isRec(json.data) ? json.data : undefined;
}

/** A repeat of a keyed write that the server is still processing: the write may still land. */
export function stillSavingResult(): CommandResult<unknown> {
  return { ok: false, error: MESSAGES.stillSaving, inProgress: true };
}

function isInFlight(outcome: { status: number; json: unknown }): boolean {
  return outcome.status === 409 && isRec(outcome.json) && isRec(outcome.json.error) && outcome.json.error.code === IN_FLIGHT_CODE;
}

/**
 * The plain reading of one request: success is `ok`, a problem is its sentence, a refusal is `ok: false`. A refusal
 * carries the server's sentence only when `withMessage` is set (the commands whose web action shows one).
 */
export function plain(outcome: ApiOutcome, withMessage = false): CommandResult<unknown> {
  if (outcome.kind === 'problem') return problemResult(outcome.problem);
  if (isSuccess(outcome.status)) return { ok: true };
  if (isInFlight(outcome)) return stillSavingResult();
  const message = withMessage ? serverMessage(outcome.json) : undefined;
  return message === undefined ? { ok: false } : { ok: false, error: message };
}
