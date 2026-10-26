import type { Api, ApiCall, ApiOutcome } from '../api-client';

export interface ScriptedApi extends Api {
  calls: ApiCall[];
}

export const reply = (status: number, json?: unknown): ApiOutcome => ({ kind: 'response', status, json });

/** An api that records every call and answers from a queue; an empty queue answers 200 with an empty object. */
export function scriptedApi(...answers: ApiOutcome[]): ScriptedApi {
  const calls: ApiCall[] = [];
  const queue = [...answers];
  return {
    calls,
    send: (call) => {
      calls.push(call);
      return Promise.resolve(queue.shift() ?? reply(200, {}));
    },
  };
}

/** The fields of a form body, files shown by name. */
export function formFields(form: FormData | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  form?.forEach((value, key) => {
    out[key] = typeof value === 'string' ? value : `file:${value.name}`;
  });
  return out;
}
