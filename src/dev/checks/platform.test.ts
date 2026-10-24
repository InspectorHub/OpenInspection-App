import { describe, expect, it } from 'vitest';
import type { AppServices } from '../../app/compose';
import { response } from '../../media/test-support/fakes';
import { createDiagRig } from '../test-support';
import { collabTicket } from './collab-ticket';
import { permissions } from './permissions';

const TICKET = 'abcdefghijklmnopqrstuvwxyz012345';

function withTicketServer(status: number, body: unknown) {
  const calls: { url: string; method: string | undefined; headers: Record<string, string> | undefined }[] = [];
  const wrap = (s: AppServices): AppServices => ({
    ...s,
    http: {
      request: (req) => {
        calls.push({ url: req.url, method: req.method, headers: req.headers });
        return Promise.resolve(response(status, body));
      },
    },
  });
  return { calls, wrap };
}

describe('permissions', () => {
  it('reports the WebView permission and tells the operator what to look at', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const result = await permissions.run(rig.ctx);
    expect(result).toMatchObject({ id: 'permissions', ok: true });
    expect(result.detail).toBe('notification_permission=default upload_notification=operator_observes_shade_during_kill_test');
  });

  it('control: an unknown or missing API is reported as unknown, never as the raw value', async () => {
    const rig = await createDiagRig({ signedIn: false });
    rig.ports.notificationPermission = () => 'something-else';
    expect((await permissions.run(rig.ctx)).detail).toContain('notification_permission=unknown');
  });
});

describe('collab-ticket', () => {
  it('reports the ticket status class and an open socket, without printing the ticket or an address', async () => {
    const server = withTicketServer(200, { success: true, data: { ticket: TICKET } });
    const rig = await createDiagRig({ wrap: server.wrap });
    rig.ports.socketProbe = { opened: true, closeCode: 1000, threw: null };
    const result = await collabTicket.run(rig.ctx);
    expect(result).toMatchObject({ id: 'collab-ticket', ok: true });
    expect(result.detail).toMatch(/^ticket=ok status=200 class=2xx ws=open close=1000 ms=\d+$/);
    expect(result.detail).not.toContain(TICKET);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe(`${rig.world.server.origin}/api/inspections/insp-1/collab/ticket`);
    expect(server.calls[0]?.method).toBe('POST');
    expect(rig.ports.sockets[0]).toContain(`/api/inspections/insp-1/collab/ws?ticket=${TICKET}`);
  });

  it('reports a socket that did not open neutrally, with its close code', async () => {
    const server = withTicketServer(200, { success: true, data: { ticket: TICKET } });
    const rig = await createDiagRig({ wrap: server.wrap });
    rig.ports.socketProbe = { opened: false, closeCode: 1006, threw: null };
    const result = await collabTicket.run(rig.ctx);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('ws=not_opened close=1006');
    expect(result.detail).not.toContain('not_available_locally');
  });

  it('reports a constructor that throws by its error name only', async () => {
    const server = withTicketServer(200, { success: true, data: { ticket: TICKET } });
    const rig = await createDiagRig({ wrap: server.wrap });
    rig.ports.socketProbe = { opened: false, closeCode: null, threw: 'SecurityError' };
    expect((await collabTicket.run(rig.ctx)).detail).toContain('ws=constructor_threw error=SecurityError');
  });

  it('control: a refused ticket fails, reports the status class, and never opens a socket', async () => {
    const server = withTicketServer(404, { success: false });
    const rig = await createDiagRig({ wrap: server.wrap });
    const result = await collabTicket.run(rig.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('ticket=refused status=404 class=4xx');
    expect(rig.ports.sockets).toEqual([]);
  });

  it('control: a 200 without a readable ticket fails', async () => {
    const server = withTicketServer(200, { success: true, data: { ticket: 'short' } });
    const rig = await createDiagRig({ wrap: server.wrap });
    expect((await collabTicket.run(rig.ctx)).detail).toBe('ticket=unreadable status=200 class=2xx');
  });

  it('shows needs sign-in, needs input, and refuses an inspection id of the wrong shape', async () => {
    expect(await collabTicket.run((await createDiagRig({ signedIn: false })).ctx)).toMatchObject({ status: 'needs_sign_in' });
    expect(await collabTicket.run((await createDiagRig({ inspectionId: '' })).ctx)).toMatchObject({ status: 'needs_input' });
    const bad = await createDiagRig({ inspectionId: '../x' });
    expect(await collabTicket.run(bad.ctx)).toMatchObject({ ok: false, detail: 'inspection_id=invalid_shape' });
  });
});
