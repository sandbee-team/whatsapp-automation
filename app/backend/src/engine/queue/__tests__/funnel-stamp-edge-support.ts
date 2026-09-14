import { randomUUID } from 'node:crypto';
import type { TestPool } from './queue-send-test-helpers.js';

/**
 * funnel-stamp-edge-support.ts (P23a test-engineer hardening pass) - shared
 * fixture helpers for `funnel-stamp-edge.integration.test.ts` and its
 * max-lines sibling `funnel-stamp-c2.integration.test.ts`. Lives under
 * `__tests__/` for the same tenant-scope guard exemption as its sibling
 * support files (no `.test.ts` suffix, never picked up as its own suite).
 */

/** Seeds one contact + one 'running' campaign wired to `jobId` + one `campaign_recipients` row at `recipientStatus`, keyed by `publicId`. */
export async function seedCampaignForJob(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  jobId: string,
  publicId: string,
  recipientStatus = 'queued',
): Promise<string> {
  const campaignId = randomUUID();
  const contactId = randomUUID();

  await pool.query(
    `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, '+15559990002', $3, '15559990002@s.whatsapp.net', 'manual')
     -- client_id = $2`,
    [contactId, clientId, Buffer.from(`funnel-stamp-edge-contact-${jobId}`)],
  );
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
     VALUES ($1, $2, $3, 'running', 'funnel stamp edge probe', $4, $5)
     -- client_id = $2`,
    [
      campaignId,
      clientId,
      instanceId,
      JSON.stringify({ kind: 'contacts', tagIds: [], contactIds: [contactId] }),
      JSON.stringify({ kind: 'text', body: 'hi' }),
    ],
  );
  await pool.query('UPDATE message_jobs SET campaign_id = $1 WHERE id = $2 AND client_id = $3', [
    campaignId,
    jobId,
    clientId,
  ]);
  await pool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, contact_id, recipient_jid, recipient_hash, status, message_job_public_id)
     VALUES ($1, $2, $3, '15559990002@s.whatsapp.net', $4, $5, $6)
     -- client_id = $1`,
    [
      clientId,
      campaignId,
      contactId,
      Buffer.from(`funnel-stamp-edge-contact-${jobId}`),
      recipientStatus,
      publicId,
    ],
  );

  return campaignId;
}

/** Reads one `campaign_recipients` row's `status`/`sent_at`/`charged_minor` by `(client_id, message_job_public_id)`. */
export async function recipientRow(
  pool: TestPool,
  clientId: string,
  publicId: string,
): Promise<{ status: string; sent_at: string | null; charged_minor: string | null } | undefined> {
  const result = await pool.query<{
    status: string;
    sent_at: string | null;
    charged_minor: string | null;
  }>(
    `SELECT status, sent_at, charged_minor::text FROM campaign_recipients
       WHERE client_id = $1 AND message_job_public_id = $2
       -- client_id = $1`,
    [clientId, publicId],
  );
  return result.rows[0];
}
