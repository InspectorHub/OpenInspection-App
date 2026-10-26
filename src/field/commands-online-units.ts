import type { CommandResult, ComplianceCommand, UnitCommand } from '@inspectorhub/field-ui';
import { apiPath, type Api } from './api-client';
import { plain } from './commands-shared';

/**
 * The online form of the per-unit and compliance commands, one request each, to the routes the web editor's
 * action calls (`app/routes/inspection-edit/action.server.ts`). Inputs the web action refuses are refused here too,
 * without a request.
 */

function never(value: never): never {
  throw new Error(`unhandled command ${JSON.stringify(value)}`);
}

export async function executeUnit(api: Api, inspectionId: string, cmd: UnitCommand, idempotencyKey: string | undefined): Promise<CommandResult<unknown>> {
  const keyed = idempotencyKey === undefined ? {} : { idempotencyKey };
  switch (cmd.op) {
    case 'create': {
      const name = cmd.name.trim();
      if (name === '') return { ok: false };
      return plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'units'), json: { parentUnitId: null, kind: 'unit', type: 'unit', name }, ...keyed }));
    }
    case 'rename': {
      const name = cmd.name.trim();
      if (cmd.unitId === '' || name === '') return { ok: false };
      return plain(await api.send({ method: 'PATCH', path: apiPath(inspectionId, 'units', cmd.unitId), json: { name } }));
    }
    case 'delete':
      if (cmd.unitId === '') return { ok: false };
      return plain(await api.send({ method: 'DELETE', path: apiPath(inspectionId, 'units', cmd.unitId) }));
    case 'duplicate':
      if (cmd.unitId === '') return { ok: false };
      return plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'units', cmd.unitId, 'duplicate'), ...keyed }));
    case 'bulk-create':
      return plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'units', 'bulk'), json: cmd.payload, ...keyed }));
    case 'mode-switch':
      return plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'unit-mode'), json: { mode: cmd.mode === 'per_unit' ? 'per_unit' : 'tagged' } }));
    default:
      return never(cmd);
  }
}

const ROLES: readonly string[] = ['field_observer', 'pcr_reviewer'];
const PSQ_STATUSES: readonly string[] = ['sent', 'received', 'declined'];

export async function executeCompliance(api: Api, inspectionId: string, cmd: ComplianceCommand): Promise<CommandResult<unknown>> {
  switch (cmd.op) {
    case 'signoff': {
      // The server signs for the signed-in user when both are absent, lets an owner or manager name both, and refuses one without the other.
      const personId = cmd.personId?.trim() ?? '';
      const name = cmd.name?.trim() ?? '';
      const signer = personId !== '' && name !== '' ? { personId, name } : {};
      const named = cmd.personId !== undefined || cmd.name !== undefined;
      if (!ROLES.includes(cmd.role) || (named && personId === '') || (named && name === '')) return { ok: false };
      const sent = plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'compliance', 'signoff'), json: { role: cmd.role, ...signer, license: cmd.license?.trim() || null, dualRole: cmd.dualRole } }));
      return sent.ok ? { ok: true, data: { role: cmd.role } } : sent;
    }
    case 'remove-signoff': {
      if (!ROLES.includes(cmd.role)) return { ok: false };
      const sent = plain(await api.send({ method: 'DELETE', path: apiPath(inspectionId, 'compliance', 'signoff', cmd.role) }));
      return sent.ok ? { ok: true, data: { role: cmd.role } } : sent;
    }
    case 'doc-review-seed':
      return plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'compliance', 'doc-review', 'seed') }));
    case 'doc-review': {
      if (cmd.documentKey === '') return { ok: false };
      const sent = plain(
        await api.send({
          method: 'PATCH',
          path: apiPath(inspectionId, 'compliance', 'doc-review', cmd.documentKey),
          json: { requested: cmd.requested, received: cmd.received, reviewed: cmd.reviewed, na: cmd.na, notes: cmd.notes || null },
        }),
      );
      return sent.ok ? { ok: true, data: { documentKey: cmd.documentKey } } : sent;
    }
    case 'psq':
      return plain(await api.send({ method: 'PUT', path: apiPath(inspectionId, 'compliance', 'psq'), json: { responses: cmd.responses } }));
    case 'psq-status': {
      if (!PSQ_STATUSES.includes(cmd.status)) return { ok: false };
      const sent = plain(await api.send({ method: 'POST', path: apiPath(inspectionId, 'compliance', 'psq', 'status'), json: { status: cmd.status, ...(cmd.reason ? { reason: cmd.reason } : {}) } }));
      return sent.ok ? { ok: true, data: { status: cmd.status } } : sent;
    }
    default:
      return never(cmd);
  }
}
