import { randomUUID } from 'node:crypto';
import type { ProbePool } from './internal-u3b-support.js';

/**
 * internal-u3b-campaign-support.ts (P28 Unit U3b, step 5) - the campaign
 * seed/probe helpers for
 * `internal-mutations-campaigns.integration.test.ts`. Split out of
 * `internal-u3b-support.ts` for that file's own `max-lines: 300` cap (the
 * established sibling-split idiom).
 *
 * A LOCAL seed rather than an import of
 * `modules/broadcasts/__tests__/broadcasts-test-support.ts`: depcruise's
 * `no-deep-module-import` forbids reaching into a sibling module's
 * `__tests__/**` - the same "intentional per-module copy, not a
 * cross-module import" note `internal-routes-test-support.ts` carries.
 * NOT itself a test file.
 */

/**
 * Seeds one `running` `campaigns` row for an already-seeded `seedSendTenant`
 * probe client and stamps `campaign_id` onto `jobIds`, so the claim
 * statement's campaign allow-list (`cp.status IN ('running','expanding')`)
 * actually governs those jobs - which is what makes the post-cancel
 * zero-claim assertion meaningful rather than vacuous.
 */
export async function seedRunningCampaignForJobs(
  pool: ProbePool,
  input: { clientId: string; instanceId: string; jobIds: string[] },
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, 'low')`,
    [
      campaignId,
      input.clientId,
      input.instanceId,
      `u3b probe campaign ${campaignId}`,
      JSON.stringify({ kind: 'contacts', tagIds: [], contactIds: [] }),
      JSON.stringify({ kind: 'text', body: 'u3b probe body' }),
    ],
  );
  // `message_jobs.id` is a BIGINT (not a uuid) - `seedQueuedJob` returns it
  // as a decimal string, so the array is cast to `bigint[]`.
  await pool.query(
    `UPDATE message_jobs SET campaign_id = $2 WHERE client_id = $1 AND id = ANY($3::bigint[])`,
    [input.clientId, campaignId, input.jobIds],
  );
  return campaignId;
}

export async function campaignRow(
  pool: ProbePool,
  clientId: string,
  campaignId: string,
): Promise<{ status: string; cancel_reason: string | null }> {
  const result = await pool.query<{ status: string; cancel_reason: string | null }>(
    `SELECT status, cancel_reason FROM campaigns WHERE id = $1 AND client_id = $2`,
    [campaignId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`campaignRow: no campaign ${campaignId} for client ${clientId}`);
  return row;
}
