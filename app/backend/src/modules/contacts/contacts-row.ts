import type { ContactSource, ConsentBasis } from '@wp/domain';
import type { ContactTagRefRow } from './contacts-tags-lookup.js';

/**
 * contacts-row.ts (P20 Unit U4, step 4) - the `contacts` row shape shared by
 * `contacts.repo.ts` and `contacts-write.ts` (300-line cap split, same
 * idiom as `session-worker-discovery-wiring.ts`).
 */

export interface ContactRow {
  id: string;
  phoneE164: string;
  waJid: string;
  addressingMode: 'pn' | 'lid';
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  attrs: Record<string, unknown>;
  source: ContactSource;
  consentBasis: ConsentBasis | null;
  optOutState: 'none' | 'opted_out';
  optedOutAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  tags: ContactTagRefRow[];
  createdAt: string;
  updatedAt: string;
}

export interface RawContactRow extends Record<string, unknown> {
  id: string;
  phone_e164: string;
  wa_jid: string;
  addressing_mode: 'pn' | 'lid';
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  attrs: Record<string, unknown>;
  source: ContactSource;
  consent_basis: ConsentBasis | null;
  opt_out_state: 'none' | 'opted_out';
  opted_out_at: Date | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapContactRow(row: RawContactRow, tags: ContactTagRefRow[]): ContactRow {
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    waJid: row.wa_jid,
    addressingMode: row.addressing_mode,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    attrs: row.attrs,
    source: row.source,
    consentBasis: row.consent_basis,
    optOutState: row.opt_out_state,
    optedOutAt: row.opted_out_at ? row.opted_out_at.toISOString() : null,
    lastInboundAt: row.last_inbound_at ? row.last_inbound_at.toISOString() : null,
    lastOutboundAt: row.last_outbound_at ? row.last_outbound_at.toISOString() : null,
    tags,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const CONTACT_COLUMNS = `id, phone_e164, wa_jid, addressing_mode, display_name, first_name, last_name,
       attrs, source, consent_basis, opt_out_state, opted_out_at, last_inbound_at, last_outbound_at,
       created_at, updated_at`;
