import { randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * P23 (broadcast-campaigns) Unit U1 seed helper for `isolation-fixtures.ts`'s
 * `seedTenant` - split into a sibling module to stay under the 300-line file
 * cap (same "move a self-contained registry/helper to a sibling module"
 * idiom `isolation-fixtures-contacts.ts` already established). Seeds one
 * `campaign_recipients` row (against the tenant's already-seeded contact)
 * and one `campaign_counters` row for the already-seeded campaign.
 */

export interface SeedBroadcastsTenantInput {
  clientId: string;
  campaignId: string;
  contactId: string;
  suffix: string;
}

export async function seedBroadcastsTenant(
  pool: pg.Pool,
  { clientId, campaignId, contactId, suffix }: SeedBroadcastsTenantInput,
): Promise<void> {
  const recipientHash = randomBytes(32);
  const digits = suffix.replace(/\D/g, '').padStart(7, '0').slice(-7);
  const recipientJid = `1555${digits}@s.whatsapp.net`;

  await pool.query(
    `INSERT INTO campaign_recipients
        (client_id, campaign_id, contact_id, recipient_jid, recipient_e164, recipient_hash)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [clientId, campaignId, contactId, recipientJid, `+1555${digits}`, recipientHash],
  );

  await pool.query(`INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)`, [
    campaignId,
    clientId,
  ]);
}
