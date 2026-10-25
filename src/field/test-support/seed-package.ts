import { accountKey, type Account } from '../../offline/outbox';
import type { Db } from '../../platform/db';
import { GLOBAL_PACKAGE_ID } from '../../offline/resource-cache';

export const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
export const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };

export const ATTRIBUTES = [{ id: 'roof_cover_material', name: 'Roof cover material', type: 'select', choices: ['Shingle', 'Tile'] }];

export const SNAPSHOT = {
  schemaVersion: 2,
  sections: [
    {
      id: 'sec_roof',
      title: 'Roof',
      items: [
        { id: 'itm_cover', label: 'Roof cover', type: 'rich', attributes: ATTRIBUTES },
        { id: 'itm_flashing', label: 'Flashing', type: 'rich' },
      ],
    },
  ],
};

export const REPORT_SECTIONS = [
  {
    id: 'sec_roof',
    name: 'Roof',
    items: [
      { id: 'itm_cover', name: 'Roof cover', type: 'rich' },
      { id: 'itm_flashing', name: 'Flashing', type: 'rich' },
    ],
  },
];

export const RESULTS = {
  '_default:sec_roof:itm_cover': { rating: 'good' },
  '_default:sec_roof:itm_flashing': { rating: 'fair' },
  'unit-1:sec_roof:itm_cover': { rating: 'poor' },
  _inspector_signature: { data: 'sig' },
};

const ok = (data: unknown): string => JSON.stringify({ success: true, data });

export interface SeedOptions {
  owner?: Account;
  /** The account the cached rows are stored under. Defaults to `owner`. */
  rowsFor?: Account;
  inspection?: Record<string, unknown>;
  bodies?: Record<string, string | null>;
  purging?: number;
  quarantined?: boolean;
  skipGlobals?: boolean;
}

/** One inspection's package as the work-package refresher stores it: a package row and its cached bodies. */
export async function seedPackage(db: Db, id: string, options: SeedOptions = {}): Promise<void> {
  const owner = options.owner ?? ALICE;
  const rowsAccount = accountKey(options.rowsFor ?? owner);
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id, purging, quarantine_source) VALUES (?, 1, 0, 1, ?, ?, ?, ?)', [
    id,
    owner.tenantId,
    owner.userId,
    options.purging ?? 0,
    options.quarantined === true ? 'reconcile_missing' : null,
  ]);
  const bodies: Record<string, string | null> = {
    [`/api/inspections/${id}`]: ok({
      inspection: { id, status: 'draft', propertyType: 'single_family', propertyAddress: '1 Main St', date: '2026-10-18T10:00:00Z', reportStatus: 'in_progress', templateSnapshot: SNAPSHOT, ...options.inspection },
    }),
    [`/api/inspections/${id}/results`]: ok({ results: RESULTS, resultId: 'res-1' }),
    [`/api/inspections/${id}/report-data`]: ok({ sections: REPORT_SECTIONS, ratingLevels: [{ id: 'good', label: 'Good', color: '#0a0' }] }),
    ...options.bodies,
  };
  for (const [key, body] of Object.entries(bodies)) {
    if (body === null) continue;
    await db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, 1, ?)', [rowsAccount, key, body, id]);
  }
  if (options.skipGlobals === true) return;
  const globals: Record<string, string> = {
    '/api/session/context': ok({
      user: { role: 'inspector', timezone: 'America/Chicago', locale: 'en-GB', dateFormat: 'iso', timeFormat: '24h', sessionMarker: 'marker-1' },
      branding: { tenantSlug: 'acme', defaultTimezone: 'America/New_York', defaultLocale: 'en-US', dateFormat: 'eu', timeFormat: '12h' },
      videoProvider: 'stream',
      collabEditing: false,
      outboundCoolingWindow: { unlockAtMs: 1_800_000_000_000, turnstileSiteKey: 'site-key' },
    }),
    '/api/tags': ok([{ id: 't1', name: 'Urgent', color: '#f00' }]),
    '/api/admin/defect-categories': ok([{ id: 'c1', name: 'Safety', color: '#f80' }]),
  };
  for (const [key, body] of Object.entries(globals)) {
    await db.run('INSERT OR IGNORE INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, 1, ?)', [rowsAccount, key, body, GLOBAL_PACKAGE_ID]);
  }
}

export { ok as envelope };
