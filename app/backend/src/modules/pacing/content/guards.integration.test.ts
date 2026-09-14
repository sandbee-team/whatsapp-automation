import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { evaluateLinkGuard } from './link-guard.js';
import { evaluateBlockedWords } from './blocked-words.js';

/**
 * guards.integration.test.ts (P14 U5 step 6; P14 U6 ext., mandatory test
 * 20) - link/blocked-words guards + the pipeline proof that a disposed
 * sibling never blocks the rest of a claim pass (disposal loop claim-again).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'content-guards-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_recipient_contacts WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM tenant_blocked_words WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const NOW = new Date('2026-09-02T10:00:00.000Z');
const RECIPIENT_HASH = Buffer.from('recipient-link-guard-fixture', 'utf8');

describe('link guard (P14 Unit U5, real Postgres)', () => {
  it('link_in_first_message_is_blocked_at_tier_one_and_allowed_at_tier_four', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const body = 'Check this out: https://example.com/promo';

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const tier1 = await evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 1,
        isGroup: false,
        now: NOW,
      });
      expect(tier1).toEqual({ ok: false, reason: 'LINK_IN_FIRST_MESSAGE', retryAt: null });

      const tier2 = await evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 2,
        isGroup: false,
        now: NOW,
      });
      expect(tier2).toEqual({ ok: false, reason: 'LINK_IN_FIRST_MESSAGE', retryAt: null });

      let warned = false;
      const tier3 = await evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 3,
        isGroup: false,
        now: NOW,
        onWarn: () => {
          warned = true;
        },
      });
      expect(tier3).toEqual({ ok: true });
      expect(warned).toBe(true);

      const tier4 = await evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 4,
        isGroup: false,
        now: NOW,
      });
      expect(tier4).toEqual({ ok: true });
    });
  });

  it('a_contact_with_first_inbound_at_is_never_blocked_even_at_tier_one', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const body = 'Here is the link: www.example-site.com/deal';

    await pool.query(
      `INSERT INTO instance_recipient_contacts (client_id, instance_id, recipient_hash, first_inbound_at)
       VALUES ($1, $2, $3, $4)`,
      [clientId, instanceId, RECIPIENT_HASH, NOW],
    );

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 1,
        isGroup: false,
        now: NOW,
      }),
    );
    expect(decision).toEqual({ ok: true });
  });

  it('a_group_job_skips_the_link_guard_entirely', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const body = 'Group announcement: https://example.com/promo';

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateLinkGuard(tx, {
        clientId,
        instanceId,
        recipientHash: RECIPIENT_HASH,
        body,
        warmupTier: 1,
        isGroup: true,
        now: NOW,
      }),
    );
    expect(decision).toEqual({ ok: true });
  });
});

describe('blocked-words guard (P14 Unit U5, real Postgres)', () => {
  it('blocked_word_reason_never_reveals_the_matched_word_or_list', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const platformDecision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateBlockedWords(tx, { clientId, body: 'Please send me the OTP right now' }),
    );
    expect(platformDecision).toEqual({
      ok: false,
      reason: 'BLOCKED_WORD',
      retryAt: null,
      category: 'otp_harvesting',
    });
    const serialised = JSON.stringify(platformDecision);
    expect(serialised).not.toContain('send me the otp');
    expect(serialised).not.toContain('OTP right now');
    expect(serialised).toContain('otp_harvesting');

    await pool.query(`INSERT INTO tenant_blocked_words (client_id, word) VALUES ($1, $2)`, [
      clientId,
      'super secret promo phrase',
    ]);

    const tenantDecision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateBlockedWords(tx, {
        clientId,
        body: 'This is our super secret promo phrase for today',
      }),
    );
    expect(tenantDecision).toEqual({
      ok: false,
      reason: 'BLOCKED_WORD',
      retryAt: null,
      category: 'tenant',
    });
    const tenantSerialised = JSON.stringify(tenantDecision);
    expect(tenantSerialised).not.toContain('super secret promo phrase');

    const cleanDecision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateBlockedWords(tx, { clientId, body: 'Your order has shipped, thanks!' }),
    );
    expect(cleanDecision).toEqual({ ok: true });
  });
});

describe('content guards - pipeline level (P14 Unit U6 extension, mandatory test 20)', () => {
  const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

  async function seedCampaignJob(p: {
    clientId: string;
    instanceId: string;
    body: string;
    orderIndex: number;
  }): Promise<{ id: string }> {
    const publicId = randomUUID();
    const params = [
      p.clientId,
      p.instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      Buffer.from(`campaign-sibling-${String(p.orderIndex)}`),
      JSON.stringify({ text: p.body }),
      String(p.orderIndex),
    ];
    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, is_new_conversation)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(),
               now() + ($6 || ' milliseconds')::interval, 0, 5, false)
       RETURNING id, created_at`,
      params,
    );
    const row = result.rows[0];
    if (!row) throw new Error('seedCampaignJob: no row returned');
    await pool.query(
      `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [publicId, p.clientId, p.instanceId, row.id, row.created_at],
    );
    return { id: row.id };
  }

  // Four siblings, insertion order: blocked-word (fails), link-in-first-
  // message at tier 1 (fails, seedSendTenant's default warmup_tier=1 is
  // <= 2), two clean siblings. ONE claimAndReserve call: the disposal loop
  // claims+disposes the first two, then reaches cleanJobA - a genuine
  // grant, a 'stop' outcome - and halts there, leaving cleanJobB untouched.
  it('blocked_word_and_first_message_link_fail_only_that_job', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });

    const base = { clientId, instanceId };
    const blockedWordJob = await seedCampaignJob({
      ...base,
      body: 'Please send me the OTP right now',
      orderIndex: 0,
    });
    const linkJob = await seedCampaignJob({
      ...base,
      body: 'Check this out: https://example.com/promo',
      orderIndex: 1,
    });
    const cleanJobA = await seedCampaignJob({ ...base, body: 'Order confirmed!', orderIndex: 2 });
    const cleanJobB = await seedCampaignJob({ ...base, body: 'See you soon!', orderIndex: 3 });

    const firstResult = await claimAndReserveFn(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'sibling-flow-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(firstResult?.id).toBe(cleanJobA.id);

    const rows = await pool.query<{ id: string; status: string; last_error_class: string | null }>(
      'SELECT id, status, last_error_class FROM message_jobs WHERE id = ANY($1)',
      [[blockedWordJob.id, linkJob.id, cleanJobA.id, cleanJobB.id]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(blockedWordJob.id)).toMatchObject({
      status: 'failed',
      last_error_class: 'BLOCKED_WORD',
    });
    expect(byId.get(linkJob.id)).toMatchObject({
      status: 'failed',
      last_error_class: 'LINK_IN_FIRST_MESSAGE',
    });
    expect(byId.get(cleanJobA.id)).toMatchObject({ status: 'processing' });
    expect(byId.get(cleanJobB.id)).toMatchObject({ status: 'queued' });
  });
});
