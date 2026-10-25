import type { CommercialPresets, PcaNarrative, PropertyMetaField, RelianceText } from '@inspectorhub/field-ui';

/**
 * Defaults the editor's commercial panels need on open: the narrative blocks, the reliance wording and the
 * property-info field lists of the commercial subtypes.
 *
 * Why this lives here: @inspectorhub/field-ui 0.2.1 exports the types of these values but not the functions and
 * constants that produce them. This module is the only place that carries local copies, and it is replaced by the
 * package's own exports when a field-ui release ships them. A test compares every value with the engine's
 * (`test-fixtures/engine-pca-values.json`), so a copy that drifts fails there.
 */

const PCA_NARRATIVE_SEED: Readonly<PcaNarrative> = {
  transmittalLetter:
    'This Property Condition Report has been prepared at your request and in accordance with the agreed scope of work. The accompanying report presents our observations, opinions of cost, and recommendations based on a walk-through survey of the subject property.',
  summaryGeneralDescription:
    'The subject property consists of the improvements identified in the General Property Description. This summary states the property facts, the consultant and user, their relationship, the transaction, the purpose of this assessment, and the date of the site visit.',
  summaryPhysicalCondition:
    'In our opinion, the property is in generally average condition for its age and use, with the material physical deficiencies and recommended actions noted in the body of this report.',
  summaryRecommendations:
    'We recommend addressing the material physical deficiencies identified herein. Where specialist evaluation is warranted, follow-up assessments are referenced in the appendices.',
  purpose:
    'The purpose of this assessment is to observe and document the physical condition of the property in support of the user’s position in the contemplated transaction.',
  scopeOfWork:
    'The scope of work comprised a walk-through survey of the readily accessible areas of the improvements, review of available documents, and interviews where practicable. The methods used are described in this section; no destructive or invasive testing was performed.',
  limitationsExceptions:
    'This assessment was limited to readily accessible areas observed at the time of the site visit. Concealed conditions, components not in service, and areas not made available were not evaluated. The observations represent the conditions existing on the date of the survey only.',
  reconnaissance:
    'A general reconnaissance of the property and its immediate surroundings was performed to observe site conditions, access, and the relationship of the improvements to adjacent uses.',
  additionalConsiderations:
    'The following considerations are outside the baseline scope of this assessment and are provided for the user’s information only: natural hazards, mold, and accessibility (ADA) are not assessed unless a separate add-on scope was engaged.',
};

const RELIANCE_TEMPLATES: Readonly<RelianceText> = {
  userReliance:
    'This Property Condition Report has been prepared for the exclusive use and ' +
    'reliance of the named User and its designated representatives in connection ' +
    'with the identified transaction. No other party may rely on this report ' +
    'without the prior written authorization of the Consultant.',
  pointInTime:
    'The observations and opinions in this report describe the condition of the ' +
    'subject property as of the date of the site visit. Property conditions may ' +
    'change after that date; the Consultant assumes no obligation to update the ' +
    'report to reflect events or conditions arising after the site visit.',
  siteSpecific:
    'This report is specific to the subject property and the scope of work agreed ' +
    'with the User. It is not a comprehensive engineering study, code-compliance ' +
    'survey, or warranty of the property, and it should be read together with the ' +
    'Limitations & Exceptions stated herein.',
};

const NARRATIVE_KEYS = Object.keys(PCA_NARRATIVE_SEED) as (keyof PcaNarrative)[];

/** Stored non-empty blocks laid over the seed; empty, blank, missing and unknown keys fall back to the seed. Never throws. */
export function resolvePcaNarrative(raw: unknown): PcaNarrative {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PcaNarrative = { ...PCA_NARRATIVE_SEED };
  for (const key of NARRATIVE_KEYS) {
    const value = stored[key];
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value;
  }
  return out;
}

/** Stored reliance text per field, else the standard wording. Read off the raw blob, which carries these three keys beside the blocks. */
export function resolveRelianceText(raw: unknown): RelianceText {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RelianceText, unknown>>;
  const pick = (key: keyof RelianceText): string => {
    const value = stored[key];
    return typeof value === 'string' && value !== '' ? value : RELIANCE_TEMPLATES[key];
  };
  return { userReliance: pick('userReliance'), pointInTime: pick('pointInTime'), siteSpecific: pick('siteSpecific') };
}

const field = (id: string, label: string, type: PropertyMetaField['type'], rest: Partial<PropertyMetaField> = {}): PropertyMetaField => ({ id, label, type, ...rest });
const yearBuilt = (): PropertyMetaField => field('yearBuilt', 'Year built', 'number', { group: 'identity', required: true });
const sprinklered = (): PropertyMetaField => field('sprinklered', 'Sprinklered', 'select', { group: 'compliance', options: ['Full', 'Partial', 'None'] });

const COMMERCIAL_PRESETS: Readonly<CommercialPresets> = {
  'commercial:office': [
    yearBuilt(),
    field('nra', 'Net rentable area', 'number', { unit: 'sqft', group: 'physical', required: true }),
    field('floorCount', 'Number of floors', 'number', { group: 'physical' }),
    field('occupancyClass', 'Occupancy classification', 'select', { group: 'compliance', options: ['B (Business)', 'A-3 (Assembly)', 'M (Mercantile)', 'Other'] }),
    sprinklered(),
    field('lastRenovation', 'Last major renovation', 'date', { group: 'maintenance' }),
  ],
  'commercial:retail': [
    yearBuilt(),
    field('gla', 'Gross leasable area', 'number', { unit: 'sqft', group: 'physical', required: true }),
    field('storefrontCount', 'Storefronts', 'number', { group: 'physical' }),
    field('anchorTenant', 'Anchor tenant', 'text', { group: 'occupancy' }),
    field('parkingSpaces', 'Parking spaces', 'number', { group: 'physical' }),
  ],
  'commercial:hospitality': [
    yearBuilt(),
    field('roomCount', 'Guest rooms', 'number', { group: 'identity', required: true }),
    field('brandAffiliation', 'Brand affiliation', 'text', { group: 'identity' }),
    field('aaaRating', 'AAA / Forbes rating', 'select', { group: 'compliance', options: ['Unrated', '1 Diamond', '2 Diamond', '3 Diamond', '4 Diamond', '5 Diamond'] }),
    field('lastRenovation', 'Last major renovation', 'date', { group: 'maintenance' }),
  ],
  'commercial:industrial': [
    yearBuilt(),
    field('sqft', 'Building area', 'number', { unit: 'sqft', group: 'physical', required: true }),
    field('clearHeight', 'Clear height', 'number', { unit: 'ft', group: 'physical' }),
    field('dockCount', 'Loading docks', 'number', { group: 'physical' }),
    field('powerCapacity', 'Power capacity', 'number', { unit: 'amps', group: 'utilities' }),
    field('railSpur', 'Rail spur', 'select', { group: 'utilities', options: ['None', 'Active', 'Removed'] }),
  ],
  'commercial:institutional': [
    yearBuilt(),
    field('sqft', 'Building area', 'number', { unit: 'sqft', group: 'physical', required: true }),
    field('occupancyType', 'Occupancy type', 'select', { group: 'compliance', options: ['E (Educational)', 'I-1 (Custodial care)', 'I-2 (Medical)', 'I-3 (Detention)', 'I-4 (Day care)'] }),
    sprinklered(),
  ],
  'commercial:mixed-use': [
    yearBuilt(),
    field('residentialUnits', 'Residential units', 'number', { group: 'identity' }),
    field('commercialSqft', 'Commercial sq ft', 'number', { unit: 'sqft', group: 'identity' }),
  ],
};

/** The `commercial:<subtype>` field lists, as a fresh copy per call so a caller cannot change the shared one. */
export function commercialPresets(): CommercialPresets {
  const out: CommercialPresets = {};
  for (const [key, fields] of Object.entries(COMMERCIAL_PRESETS)) out[key] = fields.map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) }));
  return out;
}
