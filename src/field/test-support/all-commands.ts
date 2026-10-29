import type { FieldCommand, TemplateSnapshot } from '@inspectorhub/field-ui';

const SNAPSHOT: TemplateSnapshot = { schemaVersion: 2, sections: [{ id: 's1', title: 'Roof', items: [{ id: 'i1', label: 'Cover', type: 'rich' }] }] };

/**
 * Every command the editor can send, once per type and per op. Keyed by the type, so a command added to the package
 * and not listed here fails the type-check instead of being silently untested.
 */
export const COMMANDS_BY_TYPE: Record<FieldCommand['type'], FieldCommand[]> = {
  complete: [{ type: 'complete' }],
  publish: [{ type: 'publish', markComplete: true, autoSignOnPublish: true, summary: ' Fixed roof ' }, { type: 'publish' }],
  'save-property-facts': [{ type: 'save-property-facts', payload: { yearBuilt: 1990 } }],
  'autofill-property-facts': [{ type: 'autofill-property-facts', addressString: ' 12 Test Street ' }],
  'save-settings': [{ type: 'save-settings', payload: { propertyType: 'multi_unit' } }],
  'save-pca-narrative': [{ type: 'save-pca-narrative', key: 'purpose', value: 'New purpose.' }],
  'sign-inspector': [{ type: 'sign-inspector', signatureBase64: 'c2ln' }],
  'set-cover': [{ type: 'set-cover', coverPhotoId: 'photo-key' }],
  'upload-cover': [{ type: 'upload-cover', file: new Blob(['x'], { type: 'image/jpeg' }) }],
  'crop-cover': [{ type: 'crop-cover', sourceKey: 'photo-key', crop: '{"x":0}', image: new Blob(['x']) }],
  annotate: [{ type: 'annotate', itemId: 'item-1', photoIndex: 2, nodes: '[]', image: new Blob(['x']), sectionId: 'sec-1' }],
  restructure: [{ type: 'restructure', snapshot: SNAPSHOT, collab: true }],
  'save-structure-template': [
    { type: 'save-structure-template', mode: 'new', snapshot: SNAPSHOT, name: 'Mine' },
    { type: 'save-structure-template', mode: 'back', snapshot: SNAPSHOT, templateId: 'tpl-1' },
  ],
  'add-statutory-instance': [{ type: 'add-statutory-instance', groupId: 'g1', index: 1, fields: { a: 'b' } }],
  'save-statutory-details': [{ type: 'save-statutory-details', payload: { ownerName: 'Dana' } }],
  'set-followup': [{ type: 'set-followup', itemId: 'item-1', status: 'repaired' }],
  unit: [
    { type: 'unit', op: 'create', name: ' Unit A ' },
    { type: 'unit', op: 'rename', unitId: 'u1', name: 'B' },
    { type: 'unit', op: 'delete', unitId: 'u1' },
    { type: 'unit', op: 'duplicate', unitId: 'u1' },
    { type: 'unit', op: 'bulk-create', payload: { mode: 'floors_stacks', floors: [1, 2], stacks: 2 } },
    { type: 'unit', op: 'mode-switch', mode: 'per_unit' },
  ],
  compliance: [
    { type: 'compliance', op: 'signoff', role: 'field_observer', personId: 'p1', name: 'Sam', license: ' L-1 ', dualRole: false },
    { type: 'compliance', op: 'remove-signoff', role: 'pcr_reviewer' },
    { type: 'compliance', op: 'doc-review-seed' },
    { type: 'compliance', op: 'doc-review', documentKey: 'deed', requested: true, received: false, reviewed: false, na: false, notes: null },
    { type: 'compliance', op: 'psq', responses: { q1: 'yes' } },
    { type: 'compliance', op: 'psq-status', status: 'declined', reason: 'No time' },
    { type: 'compliance', op: 'signoff', role: 'field_observer', license: null, dualRole: false },
  ],
  'load-scope': [{ type: 'load-scope', scope: 'unit-1' }],
};

export const ALL_COMMANDS: FieldCommand[] = Object.values(COMMANDS_BY_TYPE).flat();

/** Commands that are queued or read locally, so they are neither refused for being offline nor sent. */
export const LOCAL_TYPES: readonly FieldCommand['type'][] = ['complete', 'save-settings', 'load-scope'];
