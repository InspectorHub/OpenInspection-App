import { isAuthError } from '../../auth/errors';
import { collabEndpoints, isValidInspectionId } from '../../collab/connector';
import { errorWord, fail, guarded, needsInput, needsSignIn, pass, type CheckDef } from './types';

const SOCKET_WAIT_MS = 8000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

const def = { id: 'collab-ticket', title: '[diag] collab-ticket: collaboration ticket and WebSocket' };

function ticketFrom(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const { success, data } = json as { success?: unknown; data?: unknown };
  if (success !== true || typeof data !== 'object' || data === null) return null;
  const { ticket } = data as { ticket?: unknown };
  return typeof ticket === 'string' && TICKET_PATTERN.test(ticket) ? ticket : null;
}

export const collabTicket: CheckDef = {
  ...def,
  hint: 'Requests a collaboration ticket the way the connector does, then opens the WebSocket for up to 8 s. The detail reports only whether the socket opened and the close code it ended with; it does not interpret them.',
  run: (ctx) =>
    guarded(def, async () => {
      if (ctx.origin === null) return needsSignIn(def);
      if (ctx.inspectionId === '') return needsInput(def);
      if (!isValidInspectionId(ctx.inspectionId)) return fail(def, 'inspection_id=invalid_shape');
      const { services, deps } = ctx;
      const started = services.clock.now();
      const endpoints = collabEndpoints(ctx.origin, ctx.inspectionId);
      const token = await services.tokens.getAccessToken(ctx.origin);
      if (token === null) return fail(def, 'token=none');
      let status: number;
      let ticket: string | null;
      try {
        const res = await services.http.request({ url: endpoints.ticket, method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        status = res.status;
        ticket = ticketFrom(res.json);
      } catch (error) {
        return fail(def, `ticket=request_failed code=${isAuthError(error) ? error.code : errorWord(error)}`);
      }
      const statusText = `status=${String(status)} class=${String(Math.floor(status / 100))}xx`;
      if (status !== 200 || ticket === null) return fail(def, `ticket=${status === 200 ? 'unreadable' : 'refused'} ${statusText}`);
      const probe = await deps.ports.probeSocket(`${endpoints.socketBase}?ticket=${encodeURIComponent(ticket)}`, SOCKET_WAIT_MS);
      let socket: string;
      if (probe.threw !== null) socket = `ws=constructor_threw error=${probe.threw}`;
      else if (probe.opened) socket = `ws=open close=${probe.closeCode === null ? 'none' : String(probe.closeCode)}`;
      else socket = `ws=not_opened close=${probe.closeCode === null ? 'none_within_8s' : String(probe.closeCode)}`;
      return pass(def, `ticket=ok ${statusText} ${socket} ms=${String(services.clock.now() - started)}`);
    }),
};
