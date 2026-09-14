import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runExpansionBatch, runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  statementsFor,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';

/**
 * expansion.integration.test.ts (P23 Unit U4, step 5) - Phase B, the
 * ref-first expansion worker: replay safety, the mandatory crash-idempotency
 * proof (test 20), the cursor/counter once-per-batch invariant, queue-depth
 * backpressure, and concurrent-expander dedupe. The 500-contact drain demo
 * (step 8's second half) lives in the sibling `expansion-drain-demo.
 * integration.test.ts` (max-lines split - shared seed helpers moved to
 * `__tests__/broadcasts-test-support.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];
const unlimitedBudget = () =>
  createExpansionBudget({
    ratePerSecond: 1_000_000,
    burst: 1_000_000,
    clock: { now: () => Date.now() },
  });

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-expansion-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('broadcast expansion worker (Phase B)', () => {
  it('expansion_replay_creates_no_job_without_a_ref', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      50,
    );

    const first = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(first.kind).toBe('batch');

    // Replay the SAME batch statement: reset the cursor AND the recipient
    // rows' status back to 'pending' but keep their frozen `vars` etc - a
    // real crash-replay is "the batch transaction that stamped
    // status='queued' never committed", so on re-read those rows are still
    // 'pending' with the SAME dedupe_key (campaign_id + recipient_jid) the
    // first run already used - the ref-first gate must recognise them as
    // already-expanded and stamp them anyway (never leave them unaddressable).
    await pool.query('UPDATE campaigns SET expand_cursor_recipient_id = 0 WHERE id = $1', [
      campaignId,
    ]);
    await pool.query(
      `UPDATE campaign_recipients SET status = 'pending', queued_at = NULL
        WHERE campaign_id = $1`,
      [campaignId],
    );
    const replay = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(replay.kind).toBe('batch');

    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(50);
    expect(counts.refs).toBe(50);

    const orphans = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs j
         LEFT JOIN message_job_refs r ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE j.client_id = $1 AND j.campaign_id IS NOT NULL AND r.public_id IS NULL`,
      [tenant.clientId],
    );
    expect(orphans.rows[0]?.count).toBe('0');

    const unstamped = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients
        WHERE campaign_id = $1 AND message_job_public_id IS NULL`,
      [campaignId],
    );
    expect(unstamped.rows[0]?.count).toBe('0');
  });

  it('campaign_expansion_is_idempotent_across_a_crash', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      1_200,
    );

    const realTenantDb = createTenantDb(pool);
    let calls = 0;
    const crashingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        if (calls > 1) {
          throw new Error('simulated crash after first committed expansion batch');
        }
        return realTenantDb.withTenant(clientId, fn);
      },
    };

    await expect(
      runExpansionToCompletion(
        { tenantDb: crashingTenantDb, budget: unlimitedBudget() },
        { campaignId, clientId: tenant.clientId },
      ),
    ).rejects.toThrow('simulated crash');

    const afterCrash = await statementsFor(pool, tenant.clientId);
    expect(afterCrash.inserted).toBe(500);

    const cursorsSeen: string[] = [];
    const budget = unlimitedBudget();
    for (;;) {
      const result = await runExpansionBatch(
        { tenantDb: realTenantDb, budget },
        { campaignId, clientId: tenant.clientId },
      );
      if (result.kind === 'done') break;
      if (result.kind === 'batch') cursorsSeen.push(result.maxRecipientId);
    }

    for (let i = 1; i < cursorsSeen.length; i += 1) {
      expect(BigInt(cursorsSeen[i] as string)).toBeGreaterThan(
        BigInt(cursorsSeen[i - 1] as string),
      );
    }

    const final = await statementsFor(pool, tenant.clientId);
    expect(final.inserted).toBe(1_200);
    expect(final.refs).toBe(1_200);

    const distinctRecipients = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT recipient_hash)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(distinctRecipients.rows[0]?.count).toBe('1200');
  });

  it('the_cursor_and_counters_are_updated_once_per_batch', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      500,
    );

    const statements: string[] = [];
    const recordingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        return tenantDb.withTenant(clientId, (tx) =>
          fn({
            query: (async (sql: string, params?: unknown[]) => {
              if (/^\s*UPDATE\s+campaigns\b/i.test(sql)) statements.push('campaigns');
              if (/^\s*UPDATE\s+campaign_counters\b/i.test(sql))
                statements.push('campaign_counters');
              return tx.query(sql, params);
            }) as TenantQueryable['query'],
          }),
        );
      },
    };

    const result = await runExpansionBatch(
      { tenantDb: recordingTenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result.kind).toBe('batch');

    expect(statements.filter((s) => s === 'campaigns')).toHaveLength(1);
    expect(statements.filter((s) => s === 'campaign_counters')).toHaveLength(1);
  });

  it('queue_depth_backpressure_holds_the_campaign_instead_of_failing_it', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      10,
    );

    const fillerIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const row = await pool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, payload,
            payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
         VALUES ($1, $2, 0, $3, '+15550000000', '{"text":"filler"}'::jsonb, 'text', 'low', 1,
                 'queued', now(), now())
         RETURNING id`,
        [tenant.clientId, tenant.instanceId, `filler-${String(i)}@s.whatsapp.net`],
      );
      const id = row.rows[0]?.id;
      if (id) fillerIds.push(id);
    }

    const held = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget(), holdQueueDepth: 20 },
      { campaignId, clientId: tenant.clientId },
    );
    // The bounded `LIMIT holdQueueDepth + 1` probe caps the reported depth at
    // 21 even though 25 filler rows exist - the idiom `instance-card-queue-
    // depth.sql` established, never an unbounded count.
    expect(held).toEqual({ kind: 'held', reason: 'queue_depth', depth: 21 });

    const campaignRow = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('expanding');
    const recipientCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued'`,
      [campaignId],
    );
    expect(recipientCount.rows[0]?.count).toBe('0');

    await pool.query(`UPDATE message_jobs SET status = 'cancelled' WHERE id = ANY($1)`, [
      fillerIds,
    ]);

    const proceeds = await runExpansionBatch(
      { tenantDb, budget: unlimitedBudget(), holdQueueDepth: 20 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(proceeds.kind).toBe('batch');
  });

  it('two_expansion_workers_on_one_campaign_produce_no_duplicate_job', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      200,
    );

    await Promise.all([
      runExpansionToCompletion(
        { tenantDb, budget: unlimitedBudget() },
        { campaignId, clientId: tenant.clientId },
      ),
      runExpansionToCompletion(
        { tenantDb, budget: unlimitedBudget() },
        { campaignId, clientId: tenant.clientId },
      ),
    ]);

    const counts = await statementsFor(pool, tenant.clientId);
    expect(counts.inserted).toBe(200);
    expect(counts.refs).toBe(200);

    const distinctRecipients = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT recipient_hash)::text AS count FROM message_jobs
        WHERE client_id = $1 AND campaign_id = $2`,
      [tenant.clientId, campaignId],
    );
    expect(distinctRecipients.rows[0]?.count).toBe('200');
  });
});
