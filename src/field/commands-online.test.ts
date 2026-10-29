import { describe, expect, it } from 'vitest';
import type { FieldCommand } from '@inspectorhub/field-ui';
import type { ApiOutcome, ApiProblem } from './api-client';
import { executeOnline, type OnlineCommand } from './commands-online';
import { MESSAGES } from './messages';
import { COMMANDS_BY_TYPE } from './test-support/all-commands';
import { formFields, reply, scriptedApi } from './test-support/scripted-api';

const problem = (p: ApiProblem): ApiOutcome => ({ kind: 'problem', problem: p });

async function send(cmd: FieldCommand, answers: ApiOutcome[] = [], key?: string) {
  const api = scriptedApi(...answers);
  const result = await executeOnline({ api, signedAtMs: () => 777 }, 'i1', cmd as OnlineCommand, key);
  return { api, result };
}

const only = (type: FieldCommand['type'], index = 0): FieldCommand => {
  const cmd = COMMANDS_BY_TYPE[type][index];
  if (cmd === undefined) throw new Error(`no fixture for ${type}`);
  return cmd;
};

describe('online: publish', () => {
  it('completes, sets the sign flag, then publishes with a trimmed summary, in that order', async () => {
    const { api, result } = await send(only('publish'));
    expect(result).toEqual({ ok: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/inspections/i1/complete', 'PATCH /api/inspections/i1', 'POST /api/inspections/i1/publish']);
    expect(api.calls[1]?.json).toEqual({ autoSignOnPublish: true });
    expect(api.calls[2]?.json).toEqual({ summary: 'Fixed roof' });
  });

  it('the publish request carries the key the editor holds across a retry; control: no key, no header', async () => {
    const keyed = await send(only('publish', 1), [], 'key-9');
    expect(keyed.api.calls[0]?.idempotencyKey).toBe('key-9');
    const plainSend = await send(only('publish', 1));
    expect(plainSend.api.calls[0]?.idempotencyKey).toBeUndefined();
    const full = await send(only('publish'), [], 'key-9');
    expect(full.api.calls.map((c) => c.idempotencyKey)).toEqual([undefined, undefined, 'key-9']);
  });

  it('control: a bare publish is one request with an empty body', async () => {
    const { api } = await send(only('publish', 1));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/publish', json: {} });
  });

  it('a failed complete does not stop the publish', async () => {
    const { api, result } = await send(only('publish'), [reply(500)]);
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(3);
  });

  it('a sign flag that did not land stops the publish, so the report does not go out against the person choice', async () => {
    const { api, result } = await send(only('publish'), [reply(200), reply(500)]);
    expect(result).toEqual({ ok: false, error: MESSAGES.requestFailed });
    expect(api.calls.map((c) => c.path)).not.toContain('/api/inspections/i1/publish');
  });

  it('a refusal carries the sentence the server wrote, and a bare one the fixed sentence', async () => {
    const written = await send(only('publish', 1), [reply(409, { error: { code: 'X', message: 'Inspection must be completed before publishing the report.' } })]);
    expect(written.result).toEqual({ ok: false, error: 'Inspection must be completed before publishing the report.' });
    const bare = await send(only('publish', 1), [reply(500, {})]);
    expect(bare.result).toEqual({ ok: false, error: MESSAGES.publishFailed });
  });
});

describe('online: one request commands', () => {
  const table: [string, FieldCommand, string, unknown][] = [
    ['save-property-facts', only('save-property-facts'), 'PATCH /api/inspections/i1/property-facts', { yearBuilt: 1990 }],
    ['save-pca-narrative', only('save-pca-narrative'), 'PATCH /api/inspections/i1/pca-narrative', { purpose: 'New purpose.' }],
    ['sign-inspector', only('sign-inspector'), 'POST /api/inspections/i1/inspector-signature', { signatureBase64: 'c2ln', signedAt: 777 }],
    ['set-cover', only('set-cover'), 'PATCH /api/inspections/i1', { coverPhotoId: 'photo-key' }],
    ['save-statutory-details', only('save-statutory-details'), 'PATCH /api/inspections/i1/statutory-details', { ownerName: 'Dana' }],
    ['unit create', only('unit', 0), 'POST /api/inspections/i1/units', { parentUnitId: null, kind: 'unit', type: 'unit', name: 'Unit A' }],
    ['unit rename', only('unit', 1), 'PATCH /api/inspections/i1/units/u1', { name: 'B' }],
    ['unit delete', only('unit', 2), 'DELETE /api/inspections/i1/units/u1', undefined],
    ['unit duplicate', only('unit', 3), 'POST /api/inspections/i1/units/u1/duplicate', undefined],
    ['unit bulk-create', only('unit', 4), 'POST /api/inspections/i1/units/bulk', { mode: 'floors_stacks', floors: [1, 2], stacks: 2 }],
    ['unit mode-switch', only('unit', 5), 'POST /api/inspections/i1/unit-mode', { mode: 'per_unit' }],
    ['compliance signoff', only('compliance', 0), 'POST /api/inspections/i1/compliance/signoff', { role: 'field_observer', personId: 'p1', name: 'Sam', license: 'L-1', dualRole: false }],
    ['compliance remove-signoff', only('compliance', 1), 'DELETE /api/inspections/i1/compliance/signoff/pcr_reviewer', undefined],
    ['compliance doc-review-seed', only('compliance', 2), 'POST /api/inspections/i1/compliance/doc-review/seed', undefined],
    ['compliance doc-review', only('compliance', 3), 'PATCH /api/inspections/i1/compliance/doc-review/deed', { requested: true, received: false, reviewed: false, na: false, notes: null }],
    ['compliance psq', only('compliance', 4), 'PUT /api/inspections/i1/compliance/psq', { responses: { q1: 'yes' } }],
    ['compliance psq-status', only('compliance', 5), 'POST /api/inspections/i1/compliance/psq/status', { status: 'declined', reason: 'No time' }],
  ];

  it.each(table)('%s sends exactly one request to the right route', async (_name, cmd, route, body) => {
    const { api, result } = await send(cmd);
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(`${api.calls[0]?.method} ${api.calls[0]?.path}`).toBe(route);
    expect(api.calls[0]?.json).toEqual(body);
  });

  it('a sign-off sends the signer only when the command names one: both present are sent, both absent are left out', async () => {
    const both = await send(only('compliance', 0));
    expect(both.api.calls[0]?.json).toMatchObject({ personId: 'p1', name: 'Sam' });
    const absent = await send(only('compliance', 6));
    expect(absent.result.ok).toBe(true);
    expect(absent.api.calls[0]?.json).toEqual({ role: 'field_observer', license: null, dualRole: false });
    expect(Object.keys(absent.api.calls[0]?.json as object)).not.toContain('personId');
    expect(Object.keys(absent.api.calls[0]?.json as object)).not.toContain('name');
  });

  it('a sign-off with only one of the two is refused without a request, because the server refuses it', async () => {
    for (const cmd of [
      { type: 'compliance', op: 'signoff', role: 'field_observer', personId: 'p1', license: null, dualRole: false },
      { type: 'compliance', op: 'signoff', role: 'field_observer', name: 'Sam', license: null, dualRole: false },
    ] as const) {
      const { api, result } = await send(cmd);
      expect(result.ok).toBe(false);
      expect(api.calls).toHaveLength(0);
    }
  });

  it('the keyed creating commands carry the key, the others do not', async () => {
    for (const [name, cmd] of table) {
      const { api } = await send(cmd, [], 'key-1');
      const keyed = ['unit create', 'unit duplicate', 'unit bulk-create'].includes(name);
      expect(api.calls[0]?.idempotencyKey, name).toBe(keyed ? 'key-1' : undefined);
    }
  });

  it('answers the data the panels read for signoff, doc-review and psq-status; control: not on failure', async () => {
    expect((await send(only('compliance', 0))).result).toEqual({ ok: true, data: { role: 'field_observer' } });
    expect((await send(only('compliance', 3))).result).toEqual({ ok: true, data: { documentKey: 'deed' } });
    expect((await send(only('compliance', 5))).result).toEqual({ ok: true, data: { status: 'declined' } });
    expect((await send(only('compliance', 0), [reply(422)])).result).toEqual({ ok: false });
  });

  it('refuses what the web action refuses, without a request', async () => {
    const refused: FieldCommand[] = [
      { type: 'save-pca-narrative', key: '', value: 'x' },
      { type: 'unit', op: 'create', name: '   ' },
      { type: 'unit', op: 'rename', unitId: '', name: 'B' },
      { type: 'unit', op: 'delete', unitId: '' },
      { type: 'compliance', op: 'signoff', role: 'field_observer', personId: ' ', name: 'Sam', license: null, dualRole: false },
      { type: 'compliance', op: 'doc-review', documentKey: '', requested: false, received: false, reviewed: false, na: false, notes: null },
      { type: 'annotate', itemId: 'it', photoIndex: -1, nodes: '[]', image: new Blob(['x']) },
      { type: 'crop-cover', sourceKey: '', crop: '{}', image: new Blob(['x']) },
      { type: 'set-followup', itemId: '', status: null },
    ];
    for (const cmd of refused) {
      const { api, result } = await send(cmd);
      expect(result.ok, JSON.stringify(cmd.type)).toBe(false);
      expect(api.calls).toHaveLength(0);
    }
  });

  it('the signature time comes from the injected clock and from nowhere else', async () => {
    for (const at of [1, 1_800_000_000_000]) {
      const api = scriptedApi();
      await executeOnline({ api, signedAtMs: () => at }, 'i1', { type: 'sign-inspector', signatureBase64: 'c2ln' }, undefined);
      expect(api.calls[0]?.json).toEqual({ signatureBase64: 'c2ln', signedAt: at });
    }
  });

  it('an empty signature is a no-op that answers ok', async () => {
    const { api, result } = await send({ type: 'sign-inspector', signatureBase64: '' });
    expect(result).toEqual({ ok: true });
    expect(api.calls).toHaveLength(0);
  });

  it('an empty cover id clears the cover with null', async () => {
    const { api } = await send({ type: 'set-cover', coverPhotoId: '' });
    expect(api.calls[0]?.json).toEqual({ coverPhotoId: null });
  });
});

describe('online: autofill', () => {
  it('sends the trimmed address and returns the facts and reason', async () => {
    const { api, result } = await send(only('autofill-property-facts'), [reply(200, { data: { facts: { beds: 3 }, reason: null } })]);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/property-facts/autofill', json: { addressString: '12 Test Street' } });
    expect(result).toEqual({ ok: true, data: { facts: { beds: 3 }, reason: null } });
  });

  it('a short address is refused without a request; control: five characters go', async () => {
    const short = await send({ type: 'autofill-property-facts', addressString: ' 1 Ma ' });
    expect(short.result).toEqual({ ok: false, data: { facts: null, reason: 'BAD_ADDRESS' } });
    expect(short.api.calls).toHaveLength(0);
    const long = await send({ type: 'autofill-property-facts', addressString: '1 Main' });
    expect(long.api.calls).toHaveLength(1);
  });

  it('a refused lookup and an unreachable server both leave the reason the panel reads', async () => {
    const refused = await send(only('autofill-property-facts'), [reply(500)]);
    expect(refused.result).toEqual({ ok: false, data: { facts: null, reason: 'REQUEST_FAILED' } });
    const offline = await send(only('autofill-property-facts'), [problem('offline')]);
    expect(offline.result).toEqual({ ok: false, error: MESSAGES.needsConnection, data: { facts: null, reason: 'REQUEST_FAILED' } });
    const lost = await send(only('autofill-property-facts'), [problem('unknown')]);
    expect(lost.result).toEqual({ ok: false, error: MESSAGES.needsConnection, data: { facts: null, reason: 'REQUEST_FAILED' } });
  });

  it('a found-nothing answer keeps its reason', async () => {
    const { result } = await send(only('autofill-property-facts'), [reply(200, { data: { facts: null, reason: 'NOT_FOUND' } })]);
    expect(result).toEqual({ ok: true, data: { facts: null, reason: 'NOT_FOUND' } });
  });
});

describe('online: covers and annotations', () => {
  it('upload-cover uploads the file with the key, then sets it as the cover', async () => {
    const { api, result } = await send(only('upload-cover'), [reply(200, { data: { key: 'k-1', url: '/u/k-1' } })], 'key-1');
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/inspections/i1/media/upload', 'PATCH /api/inspections/i1']);
    expect(formFields(api.calls[0]?.form)).toEqual({ file: 'file:cover.jpg' });
    expect(api.calls[0]?.idempotencyKey).toBe('key-1');
    expect(api.calls[1]?.json).toEqual({ coverPhotoId: 'k-1' });
    expect(api.calls[1]?.idempotencyKey).toBeUndefined();
    expect(result).toEqual({ ok: true, data: { coverKey: 'k-1', coverUrl: '/u/k-1' } });
  });

  it('upload-cover without a key in the answer stops there; one that fails to set the cover is not ok', async () => {
    const noKey = await send(only('upload-cover'), [reply(200, { data: {} })]);
    expect(noKey.result).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
    expect(noKey.api.calls).toHaveLength(1);
    const notSet = await send(only('upload-cover'), [reply(200, { data: { key: 'k-1' } }), reply(500)]);
    expect(notSet.result).toEqual({ ok: false });
  });

  it('crop-cover posts the image, source and crop, and returns the new key', async () => {
    const { api, result } = await send(only('crop-cover'), [reply(200, { data: { coverImageKey: 'c-2' } })]);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/cover' });
    expect(formFields(api.calls[0]?.form)).toEqual({ image: 'file:cover.jpg', sourceKey: 'photo-key', crop: '{"x":0}' });
    expect(result).toEqual({ ok: true, data: { coverKey: 'c-2' } });
    expect((await send(only('crop-cover'), [reply(200, {})])).result).toEqual({ ok: true, data: { coverKey: null } });
  });

  it('annotate addresses the photo by item and index and sends the nodes and the section', async () => {
    const { api, result } = await send(only('annotate'));
    expect(result.ok).toBe(true);
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/items/item-1/photos/2/annotation' });
    expect(formFields(api.calls[0]?.form)).toEqual({ image: 'file:annotation.png', nodes: '[]', sectionId: 'sec-1' });
  });

  it('control: without a section the field is left out', async () => {
    const { api } = await send({ type: 'annotate', itemId: 'item-1', photoIndex: 0, nodes: '[]', image: new Blob(['x']) });
    expect(formFields(api.calls[0]?.form)).not.toHaveProperty('sectionId');
  });

  it('an item id with a slash cannot change the path', async () => {
    const { api, result } = await send({ type: 'annotate', itemId: '../../x', photoIndex: 0, nodes: '[]', image: new Blob(['x']) });
    expect(result).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(api.calls).toHaveLength(0);
    const fine = await send({ type: 'annotate', itemId: 'item.v2', photoIndex: 0, nodes: '[]', image: new Blob(['x']) });
    expect(fine.api.calls[0]?.path).toBe('/api/inspections/i1/items/item.v2/photos/0/annotation');
  });
});

describe('online: structure', () => {
  it('restructure saves the snapshot, then asks live sessions to converge', async () => {
    const { api, result } = await send(only('restructure'));
    expect(result).toEqual({ ok: true });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /api/inspections/i1/template-snapshot', 'POST /api/inspections/i1/collab/restructure']);
  });

  it('control: without collab there is no convergence request', async () => {
    const { api } = await send({ type: 'restructure', snapshot: { schemaVersion: 2, sections: [] }, collab: false });
    expect(api.calls).toHaveLength(1);
  });

  it('a refused convergence is told; collab switched off (501) is tolerated', async () => {
    expect((await send(only('restructure'), [reply(200), reply(403)])).result).toEqual({ ok: false, error: MESSAGES.syncNotConverged });
    expect((await send(only('restructure'), [reply(200), reply(501)])).result).toEqual({ ok: true });
  });

  it('a convergence step that could not be completed at all says so, whatever stopped it', async () => {
    for (const kind of ['offline', 'unknown', 'auth', 'upgrade', 'locked'] as const) {
      expect((await send(only('restructure'), [reply(200), problem(kind)])).result, kind).toEqual({ ok: false, error: MESSAGES.syncNotConverged });
    }
    expect((await send(only('restructure'), [reply(200), reply(200)])).result).toEqual({ ok: true });
  });

  it('a snapshot the server refused is a failure, not a silent success', async () => {
    const { api, result } = await send(only('restructure'), [reply(422)]);
    expect(result).toEqual({ ok: false, error: MESSAGES.structureNotSaved });
    expect(api.calls).toHaveLength(1);
  });

  it('save-structure-template new forks a template, with the default name when blank', async () => {
    const named = await send(only('save-structure-template', 0));
    expect(named.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/templates', json: { name: 'Mine' } });
    const blank = await send({ type: 'save-structure-template', mode: 'new', snapshot: { schemaVersion: 2, sections: [] }, name: '  ' });
    expect(blank.api.calls[0]?.json).toMatchObject({ name: 'Custom Template' });
  });

  it('save-structure-template back reads the source name, then updates the source in place', async () => {
    const { api, result } = await send(only('save-structure-template', 1), [reply(200, { data: { template: { id: 'tpl-1', name: ' Source ' } } })]);
    expect(result.ok).toBe(true);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/inspections/templates/tpl-1', 'PUT /api/inspections/templates/tpl-1']);
    expect(api.calls[1]?.json).toMatchObject({ name: 'Source' });
  });

  it('save-structure-template back refuses a template id the URL parser would resolve away, without a request', async () => {
    const snapshot = { schemaVersion: 2 as const, sections: [] };
    for (const templateId of ['..', '%2e%2e', 'a/b']) {
      const { api, result } = await send({ type: 'save-structure-template', mode: 'back', snapshot, templateId });
      expect(result, templateId).toEqual({ ok: false, error: MESSAGES.invalidValue });
      expect(api.calls).toHaveLength(0);
    }
  });

  it('save-structure-template back never renames the source: no id, unreadable source and a nameless one all fail before the PUT', async () => {
    const snapshot = { schemaVersion: 2 as const, sections: [] };
    const noId = await send({ type: 'save-structure-template', mode: 'back', snapshot, templateId: '' });
    expect(noId.result).toEqual({ ok: false, error: MESSAGES.noSourceTemplate });
    expect(noId.api.calls).toHaveLength(0);
    const unreadable = await send(only('save-structure-template', 1), [reply(404)]);
    expect(unreadable.result).toEqual({ ok: false, error: MESSAGES.sourceTemplateUnreadable });
    const nameless = await send(only('save-structure-template', 1), [reply(200, { data: { template: { id: 'tpl-1', name: ' ' } } })]);
    expect(nameless.result).toEqual({ ok: false, error: MESSAGES.sourceTemplateUnnamed });
    for (const r of [unreadable, nameless]) expect(r.api.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('online: statutory instance and follow-up', () => {
  it('add-statutory-instance posts the group, index and fields with the key', async () => {
    const { api, result } = await send(only('add-statutory-instance'), [], 'key-3');
    expect(result).toEqual({ ok: true });
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/statutory-form/instances', json: { groupId: 'g1', index: 1, fields: { a: 'b' } }, idempotencyKey: 'key-3' });
  });

  it('add-statutory-instance shows the sentence of the one refusal it raises, else a fixed one', async () => {
    expect((await send(only('add-statutory-instance'), [reply(422, { error: { message: 'No slot named g1.' } })])).result).toEqual({ ok: false, error: 'No slot named g1.' });
    expect((await send(only('add-statutory-instance'), [reply(500)])).result).toEqual({ ok: false, error: MESSAGES.instanceNotRecorded });
  });

  it('a repeat the server is still processing is told as in progress, not as a refusal', async () => {
    const { result } = await send(only('unit', 0), [reply(409, { error: { code: 'IDEMPOTENCY_IN_FLIGHT' } })], 'key-1');
    expect(result).toEqual({ ok: false, error: MESSAGES.stillSaving, inProgress: true });
    const other = await send(only('unit', 0), [reply(409, { error: { code: 'OTHER' } })], 'key-1');
    expect(other.result).toEqual({ ok: false });
  });

  it('set-followup sends the status, and the note only when given', async () => {
    const bare = await send(only('set-followup'));
    expect(bare.api.calls[0]).toMatchObject({ method: 'POST', path: '/api/inspections/i1/collab/followup', json: { itemId: 'item-1', status: 'repaired' } });
    expect(bare.api.calls[0]?.json).not.toHaveProperty('notes');
    const noted = await send({ type: 'set-followup', itemId: 'item-1', status: null, notes: 'Done' });
    expect(noted.api.calls[0]?.json).toEqual({ itemId: 'item-1', status: null, notes: 'Done' });
  });

  it('set-followup tells why it failed: live editing off, ambiguous, the server sentence, or a fixed one', async () => {
    expect((await send(only('set-followup'), [reply(501)])).result.error).toBe(MESSAGES.followupNeedsLiveEditing);
    expect((await send(only('set-followup'), [reply(409, { reason: 'ambiguous' })])).result.error).toBe(MESSAGES.followupAmbiguous);
    expect((await send(only('set-followup'), [reply(400, { error: 'Refused key.' })])).result.error).toBe('Refused key.');
    expect((await send(only('set-followup'), [reply(500, {})])).result.error).toBe(MESSAGES.followupNotSaved);
  });
});

describe('online: problems are told in fixed sentences', () => {
  it.each([
    ['offline', MESSAGES.needsConnection],
    ['unknown', MESSAGES.outcomeUnknown],
    ['auth', MESSAGES.sessionExpired],
    ['upgrade', MESSAGES.upgradeRequired],
    ['locked', MESSAGES.deviceLocked],
    ['server_too_old', MESSAGES.serverTooOld],
  ] as const)('%s', async (kind, sentence) => {
    const { result } = await send(only('set-cover'), [problem(kind)]);
    expect(result).toEqual({ ok: false, error: sentence });
  });

  it('an unknown outcome never says the device needs a connection, and says the change may have been saved', () => {
    expect(MESSAGES.outcomeUnknown).not.toBe(MESSAGES.needsConnection);
    expect(MESSAGES.outcomeUnknown).toMatch(/may/);
  });

  it('an unknown outcome of a publish warns that publishing again can create a second revision; no other command says that', async () => {
    const publish = await send(only('publish', 1), [problem('unknown')]);
    expect(publish.result).toEqual({ ok: false, error: MESSAGES.publishOutcomeUnknown });
    expect(MESSAGES.publishOutcomeUnknown).toMatch(/second revision/);
    expect(MESSAGES.outcomeUnknown).not.toMatch(/revision/);
    const cover = await send(only('set-cover'), [problem('unknown')]);
    expect(cover.result.error).not.toMatch(/revision/);
  });

  it('control: a publish that was refused before it was applied is not an unknown outcome', async () => {
    expect((await send(only('publish', 1), [problem('offline')])).result.error).toBe(MESSAGES.needsConnection);
  });

  it('a 403 says the account is not allowed; any other plain refusal stays a bare ok: false', async () => {
    expect((await send(only('set-cover'), [reply(403, { error: { message: 'secret detail' } })])).result).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect((await send(only('set-cover'), [reply(422, { error: { message: 'secret detail' } })])).result).toEqual({ ok: false });
  });
});
