/**
 * P20 (contacts-and-import) Unit U1 delta enums (migration 0060) - labels
 * verbatim, in the exact declared order (db/tests/enum-parity.test.ts
 * asserts order equality). Split out of `index.ts` (P28 U1, to stay under
 * the `max-lines: 300` cap - same "move a self-contained delta-enum block to
 * a sibling module" idiom as `./p28-admin.ts`); re-exported unchanged from
 * `index.ts` and merged into `PG_ENUMS` there.
 */
export const CONTACT_SOURCES = ['import', 'inbound', 'manual', 'api'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CONTACT_OPT_OUT_STATES = ['none', 'opted_out'] as const;
export type ContactOptOutState = (typeof CONTACT_OPT_OUT_STATES)[number];

export const CONTACT_IMPORT_STATUSES = [
  'uploaded',
  'validating',
  'importing',
  'done',
  'failed',
  'cancelled',
] as const;
export type ContactImportStatus = (typeof CONTACT_IMPORT_STATUSES)[number];

export const CONSENT_BASES = [
  'user_declared_optin',
  'imported_with_attestation',
  'inbound_initiated',
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];
