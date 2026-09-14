import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { FileKeyProvider, type KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { detectInboundOptOut } from '../../modules/inbound/optout-detect.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { evaluateBlockedWords } from '../../modules/pacing/content/blocked-words.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-tenant-fixture.js';

/**
 * guard-isolation.e2e.integration.test.ts (P14 Unit U7, step 5 - two-tenant
 * isolation) - suite-B idiom (`send-path-isolation.e2e.integration.test.ts`
 * sibling), extended to the P14 guard surfaces: an inbound STOP from one
 * tenant's contact must never cancel another tenant's queued jobs to the
 * SAME phone number, and a tenant's blocked-word/opt-out rows must never
 * leak into a sibling tenant's guard evaluation (core invariant 4, tenant
 * isolation everywhere).
 *
 * SAME E.164 ACROSS TENANTS (documented, task instruction verbatim): the
 * opt-out pepper is a GLOBAL KEK (`optout-pepper` purpose), so
 * `hashRecipient` produces the SAME `phone_hash` bytes for the same E.164
 * regardless of which tenant looks it up - isolation here comes from
 * `client_id` SCOPING on every opt-out/guard query, never from the hash
 * itself differing per tenant.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'guard-isolation-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
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

/** Same distinct-kekId-per-purpose fixture ring idiom as every other P14 test's own `makeOptoutPepperRing`. */
function makeKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-guard-isolation-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0e).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return new FileKeyProvider({
    ringPath: path,
    // detectInboundOptOut calls BOTH hashRecipient ('optout-pepper') and
    // sealPhoneForOptOut ('tenant-secrets') internally - unlike
    // registry.integration.test.ts's own fixture ring (which never calls
    // sealPhoneForOptOut, passing a plain fixture buffer for phoneEnc
    // instead), this test drives the real detectInboundOptOut end to end
    // and needs both purposes mounted.
    mountedPurposes: ['optout-pepper', 'tenant-secrets'],
  });
}

async function seedQueuedJobTo(
  clientId: string,
  instanceId: string,
  e164: string,
  recipientHash: Buffer | null,
  body = 'Thanks for your order, see you soon!',
): Promise<string> {
  const publicId = randomUUID();
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, $4, $6, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      `${e164.replace(/^\+/u, '')}@s.whatsapp.net`,
      e164,
      JSON.stringify({ text: body }),
      recipientHash,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedJobTo: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}

async function jobStatus(jobId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM message_jobs WHERE id = $1',
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobStatus: no row for ${jobId}`);
  return row.status;
}

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('guard isolation across two tenants (P14 Unit U7, real Postgres)', () => {
  it('tenant_b_stop_never_cancels_tenant_a_jobs_to_the_same_number', async () => {
    const { clientId: clientA, instanceId: instanceA } = await seedSendTenant(pool, probeClientIds);
    const { clientId: clientB, instanceId: instanceB } = await seedSendTenant(pool, probeClientIds);
    const sharedE164 = '+15559990000';
    const provider = makeKeyProvider();
    const sharedPhoneHash = hashRecipient(provider, sharedE164);

    const jobA = await seedQueuedJobTo(clientA, instanceA, sharedE164, sharedPhoneHash);
    const jobB = await seedQueuedJobTo(clientB, instanceB, sharedE164, sharedPhoneHash);

    // Tenant B's contact sends an inbound STOP - attributed opt-out,
    // recorded and enforced ONLY under clientB's scope.
    await tenantDb.withTenant(clientB, async (tx: TenantQueryable) => {
      const result = await detectInboundOptOut(
        // No contacts mirror wiring needed in this suite - it proves
        // cross-tenant opt-out enforcement, not the P20 mirror port (that
        // is optout-mirror.integration.test.ts's own case).
        { tx, provider, mirror: async () => ({ contactsUpdated: 0 }) },
        {
          clientId: clientB,
          instanceId: instanceB,
          senderJid: `${sharedE164.replace(/^\+/u, '')}@s.whatsapp.net`,
          senderE164: sharedE164,
          text: 'STOP',
          tenantKeywords: [],
        },
      );
      expect(result.attributed).toBe(true);
    });

    // Tenant A's job to the SAME phone number is completely unaffected -
    // still queued, never cancelled by a sibling tenant's opt-out.
    expect(await jobStatus(jobA)).toBe('queued');
    // Tenant B's own job to that number IS cancelled by its own opt-out.
    expect(await jobStatus(jobB)).toBe('cancelled');

    // Tenant A's guard pipeline still claims its job normally (opt-out gate
    // passes under clientA's own scope - the recipient never opted out of
    // tenant A).
    const claimFn = claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
    await claimFn(
      { clientId: clientA, sql: pool },
      {
        instanceId: instanceA,
        band: 3,
        fence: 1,
        workerId: 'guard-isolation-worker',
        claimExpiryMs: 90_000,
      },
    );
    const afterClaimA = await jobStatus(jobA);
    expect(['processing', 'queued']).toContain(afterClaimA);
    expect(afterClaimA).not.toBe('cancelled');
  });

  it('tenant_a_guard_pipeline_unaffected_by_tenant_b_blocking_rows', async () => {
    const { clientId: clientA, instanceId: instanceA } = await seedSendTenant(pool, probeClientIds);
    const { clientId: clientB } = await seedSendTenant(pool, probeClientIds);
    const sharedPhrase = 'totally normal seasonal promotion phrase';

    // Tenant B blocks a word that tenant A uses innocently in its own copy.
    await pool.query(`INSERT INTO tenant_blocked_words (client_id, word) VALUES ($1, $2)`, [
      clientB,
      sharedPhrase,
    ]);

    // Tenant A's own blocked-word evaluation, scoped to clientA only - the
    // sibling tenant's blocking row never applies.
    const decisionA = await tenantDb.withTenant(clientA, (tx: TenantQueryable) =>
      evaluateBlockedWords(tx, {
        clientId: clientA,
        body: `Check out our ${sharedPhrase} today!`,
      }),
    );
    expect(decisionA).toEqual({ ok: true });

    // Tenant A's queued job to an unrelated recipient, carrying that exact
    // phrase, claims and evaluates normally through the real pipeline.
    const jobA = await seedQueuedJobTo(
      clientA,
      instanceA,
      '+15559991111',
      null,
      `Check out our ${sharedPhrase} today!`,
    );
    const claimFn = claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
    await claimFn(
      { clientId: clientA, sql: pool },
      {
        instanceId: instanceA,
        band: 3,
        fence: 1,
        workerId: 'guard-isolation-worker-2',
        claimExpiryMs: 90_000,
      },
    );
    const afterClaimA = await jobStatus(jobA);
    expect(afterClaimA).not.toBe('failed');
    expect(['processing', 'queued']).toContain(afterClaimA);
  });
});
