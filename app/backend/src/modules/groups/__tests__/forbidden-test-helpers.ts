import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * modules/groups/__tests__/forbidden-test-helpers.ts (P24 Unit U4b) - fixture
 * helpers for `forbidden.integration.test.ts`/`receipts.integration.test.ts`
 * beyond what the shared `groups-test-helpers.ts` (`wa_groups` seeding) and
 * `queue-send-test-helpers.ts` (send-path seeding) already cover: a claimed
 * `message_jobs` row already carrying a `@g.us` recipient (the shared
 * `seedClaimedJob` hardcodes a `@s.whatsapp.net` DM jid) plus a minimal
 * `campaigns`/`campaign_recipients` pair for the group-receipt funnel-stamp
 * test. Lives under `__tests__/` for the same tenant-scope-guard seed/
 * cleanup exemption reasoning `groups-test-helpers.ts`'s own header gives.
 */

type Pool = ReturnType<typeof createPool>;

export interface SeedGroupClaimedJobOptions {
  clientId: string;
  instanceId: string;
  groupJid: string;
  attempts?: number;
  maxAttempts?: number;
  leaseId?: string;
  campaignId?: string | null;
}

export interface SeededGroupClaimedJob {
  id: string;
  createdAt: Date;
  leaseId: string;
  publicId: string;
}

/** Same shape as `queue-send-test-helpers.ts#seedClaimedJob`, but for a `@g.us` recipient (`recipient_e164` NULL, per `mj_recipient_shape`). */
export async function seedGroupClaimedJob(
  pool: Pool,
  options: SeedGroupClaimedJobOptions,
): Promise<SeededGroupClaimedJob> {
  const leaseId = options.leaseId ?? randomUUID();
  const publicId = randomUUID();

  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at,
        campaign_id)
     VALUES ($1, $2, 0, $3, NULL, $4, 'text', 'normal', 10, 'processing', now(),
             now(), $5, $6, 'worker-1', $7, 1, now(), now() + interval '90 seconds', $8)
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      options.groupJid,
      JSON.stringify({ text: 'hello group' }),
      options.attempts ?? 0,
      options.maxAttempts ?? 5,
      leaseId,
      options.campaignId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGroupClaimedJob: no row returned');

  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );

  return { id: row.id, createdAt: row.created_at, leaseId, publicId };
}

export interface SeededGroupDispatchedAttempt extends SeededGroupClaimedJob {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  attemptNo: number;
}

/** Mirrors `queue-send-test-helpers.ts#seedDispatchedAttempt` for a `@g.us` recipient: a claimed job PLUS its `send_attempts` row already `state='dispatched'`. */
export async function seedGroupDispatchedAttempt(
  pool: Pool,
  options: SeedGroupClaimedJobOptions,
): Promise<SeededGroupDispatchedAttempt> {
  const job = await seedGroupClaimedJob(pool, options);
  const attemptNo = (options.attempts ?? 0) + 1;
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at)
     SELECT $1, $2, $3, j.created_at, $4, $5, 'dispatched', now(), now()
       FROM message_jobs j WHERE j.id = $3`,
    [options.clientId, options.instanceId, job.id, job.leaseId, attemptNo],
  );
  return {
    ...job,
    clientId: options.clientId,
    instanceId: options.instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    attemptNo,
  };
}

export interface SeedMinimalCampaignOptions {
  clientId: string;
  instanceId: string;
}

/** The minimal NOT-NULL column set `campaigns` (migration 0010 + 0064's ALTER) requires - just enough for a `campaign_recipients` FK target, never the full broadcast lifecycle. */
export async function seedMinimalCampaign(
  pool: Pool,
  options: SeedMinimalCampaignOptions,
): Promise<string> {
  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, name, audience, message, target_kind)
     VALUES ($1, $2, $3, 'probe campaign', '{}'::jsonb, '{}'::jsonb, 'groups')`,
    [campaignId, options.clientId, options.instanceId],
  );
  return campaignId;
}

export interface SeedCampaignRecipientGroupOptions {
  clientId: string;
  campaignId: string;
  groupId: string;
  groupJid: string;
  messageJobPublicId: string;
  status?: string;
}

/** Seeds one `campaign_recipients` row keyed by `group_id` (`cr_exactly_one_target` requires exactly one of contact_id/group_id) with `message_job_public_id` set - the receipt-stamp path (`stampCampaignRecipientReceipt`) joins on that column via `message_job_refs`. */
export async function seedCampaignRecipientGroup(
  pool: Pool,
  options: SeedCampaignRecipientGroupOptions,
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status,
        message_job_public_id, queued_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
    [
      options.clientId,
      options.campaignId,
      options.groupId,
      options.groupJid,
      Buffer.from('probe-group-hash'),
      options.status ?? 'sent',
      options.messageJobPublicId,
    ],
  );
}

/** Deletes every `campaign_recipients`/`campaigns` row of the given probe clients - call BEFORE `cleanupWaGroups`/`cleanupSendProbeClients` (no FK from campaign_recipients to wa_groups per migration 0066's own note, but campaigns->whatsapp_instances still needs campaigns gone first). */
export async function cleanupForbiddenTestCampaigns(
  pool: Pool,
  probeClientIds: readonly string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1::uuid[])', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1::uuid[])', [probeClientIds]);
}

export interface SeededDmAttempt {
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  publicId: string;
  recipientJid: string;
}

/** DM-side counterpart to `seedGroupDispatchedAttempt` - a claimed `@s.whatsapp.net` job already `dispatched`, shared by both `forbidden.integration.test.ts` and `forbidden-edge.integration.test.ts` (the "an untouched DM still sends/pauses" halves of those suites). */
export async function seedDmDispatchedAttempt(
  pool: Pool,
  clientId: string,
  instanceId: string,
): Promise<SeededDmAttempt> {
  const leaseId = randomUUID();
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10,
             'processing', now(), now(), 0, 5, 'worker-1', $5, 1, now(), now() + interval '90 seconds')
     RETURNING id, created_at`,
    [clientId, instanceId, recipientJid, JSON.stringify({ text: 'hi' }), leaseId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedDmDispatchedAttempt: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
    [clientId, instanceId, row.id, row.created_at, leaseId],
  );
  return { jobId: row.id, jobCreatedAt: row.created_at, leaseId, publicId, recipientJid };
}
