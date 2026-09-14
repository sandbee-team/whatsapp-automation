import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from './index.js';
import {
  DEFAULT_CLAIM_INPUT,
  cleanupProbeClients,
  ctxFor,
  getJob,
  getJobWithLease,
  seedExtraInstance,
  seedJob,
  seedTenant,
  seedTenantEdgeProbe,
  type TestPool,
} from './__tests__/claim-test-helpers.js';

/**
 * claim.rls.integration.test.ts (P03 close, split from
 * `claim.integration.test.ts` + `claim.edge-cases.integration.test.ts` for
 * file-size, protocol C2) - tenant-isolation and role/RLS/fence probes for
 * `claimOne`: same-client two-instance fence blast radius (a stale fence on
 * one instance must not affect a sibling instance under the same client),
 * ADR 0026 cross-tenant probe (a malformed `client_id A / instance_id B` row
 * is claimable by neither A's nor B's context), wrong-GUC (`app.client_id`
 * set to the WRONG tenant under `wp_scheduler` + RLS yields zero claims and
 * zero lease residue), and the real-role positive/negative pair proving
 * grants + RLS + the claim statement line up under `wp_scheduler`.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('claimOne tenant isolation, fencing, and role/RLS', () => {
  it('two_instances_of_the_same_client_one_stale_fence_one_valid_only_the_valid_instance_claims', async () => {
    const { clientId, instanceId: staleInstanceId } = await seedTenantEdgeProbe(
      pool,
      probeClientIds,
      { fence: 5, instanceLabel: 'stale-fence' },
    );
    const validInstanceId = await seedExtraInstance(pool, clientId, {
      fence: 1,
      instanceLabel: 'valid-fence',
    });

    const staleJobId = await seedJob(pool, { clientId, instanceId: staleInstanceId });
    const validJobId = await seedJob(pool, { clientId, instanceId: validInstanceId });

    // Caller presents fence=1 for BOTH instances - correct for the valid
    // instance, stale for the other. Blast radius must be per-instance:
    // the valid instance's claim must succeed even though a sibling
    // instance under the SAME client is fenced off.
    const staleAttempt = await claimOne(ctxFor(clientId, pool), {
      instanceId: staleInstanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: 1,
    });
    expect(staleAttempt).toBeUndefined();

    const validAttempt = await claimOne(ctxFor(clientId, pool), {
      instanceId: validInstanceId,
      ...DEFAULT_CLAIM_INPUT,
      fence: 1,
    });
    expect(validAttempt?.id).toBe(validJobId);

    const staleJob = await getJobWithLease(pool, staleJobId);
    expect(staleJob.status).toBe('queued');
  });

  it('a_job_pointing_at_another_tenants_instance_is_never_claimed', async () => {
    // ADR 0026 (P03 C1 CRITICAL): a malformed row with client_id=A but
    // instance_id pointing at tenant B's whatsapp_instances/
    // instance_lease_state row must never be claimable - neither by A's own
    // context (the instance-scoped joins are for a DIFFERENT tenant) nor by
    // B's context (the job's client_id doesn't match). `message_jobs`
    // deliberately carries no FK on instance_id, so this INSERT (superuser,
    // bypassing RLS/app-level validation on purpose) is the only way to
    // manufacture the malformed row this test probes.
    const tenantA = await seedTenantEdgeProbe(pool, probeClientIds);
    const tenantB = await seedTenantEdgeProbe(pool, probeClientIds);

    const malformedJobId = await seedJob(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantB.instanceId,
    });

    const asTenantA = await claimOne(ctxFor(tenantA.clientId, pool), {
      instanceId: tenantB.instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(asTenantA).toBeUndefined();

    const asTenantB = await claimOne(ctxFor(tenantB.clientId, pool), {
      instanceId: tenantB.instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(asTenantB).toBeUndefined();

    const malformedJob = await getJobWithLease(pool, malformedJobId);
    expect(malformedJob.status).toBe('queued');
    expect(malformedJob.lease_owner).toBeNull();
    expect(malformedJob.lease_id).toBeNull();
    expect(malformedJob.owner_fence).toBeNull();
    expect(malformedJob.leased_at).toBeNull();
    expect(malformedJob.lease_expires_at).toBeNull();
  });

  it('claim_under_wrong_app_client_id_yields_zero_claims', async () => {
    const tenantA = await seedTenantEdgeProbe(pool, probeClientIds);
    const tenantB = await seedTenantEdgeProbe(pool, probeClientIds);
    const jobId = await seedJob(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      // app.client_id set to tenant B, but the claim params (ctx.clientId,
      // instanceId) are tenant A's - RLS on message_jobs/whatsapp_instances/
      // instance_lease_state/clients/wallet_accounts filters every row down
      // to tenant B before the claim's own WHERE/join predicates ever run,
      // so this must yield zero claims even though tenant A's job is
      // genuinely eligible from A's own point of view.
      await client.query('SELECT set_config($1, $2, true)', ['app.client_id', tenantB.clientId]);

      const claimed = await claimOne(ctxFor(tenantA.clientId, client), {
        instanceId: tenantA.instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(claimed).toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // Mirrors a_job_pointing_at_another_tenants_instance_is_never_claimed's
    // pause-preserves-work assertions: not merely "not returned", but no
    // lease residue of any kind was left behind by the wrong-GUC attempt.
    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('queued');
    expect(job.lease_owner).toBeNull();
    expect(job.lease_id).toBeNull();
    expect(job.owner_fence).toBeNull();
    expect(job.leased_at).toBeNull();
    expect(job.lease_expires_at).toBeNull();
  });

  // finding 5, P03 close: claimOne is only ever exercised as the superuser
  // `wp` role above - proves it also works (and fails safely) under the
  // real production role, wp_scheduler, whose grants + RLS depend on
  // `app.client_id` being set via `set_config` first (see ClaimOneCtx's own
  // doc comment, queue.repo.ts).
  it('claim_succeeds_under_wp_scheduler_role_with_tenant_guc', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
      await client.query('SET LOCAL ROLE wp_scheduler');

      // Kills the vacuous-superuser mode: without this, the claim below could
      // silently pass under the connecting superuser role, RLS never actually
      // engaged, and this test would prove nothing about wp_scheduler + RLS.
      const roleCheck = await client.query<{ current_user: string; row_security: string }>(
        'SELECT current_user, current_setting($1) AS row_security',
        ['row_security'],
      );
      expect(roleCheck.rows[0]?.current_user).toBe('wp_scheduler');
      expect(roleCheck.rows[0]?.row_security).toBe('on');

      const claimed = await claimOne(ctxFor(clientId, client), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });

      expect(claimed?.id).toBe(jobId);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('claim_under_wp_scheduler_without_tenant_guc_returns_no_rows', async () => {
    // No set_config('app.client_id', ...) call - the RLS policies on every
    // joined table filter to zero visible rows, so the claim honestly finds
    // nothing to claim. P06 is the phase that binds real workers to
    // TenantDb.withTenant (db/src/tenant-db.ts), which always sets the GUC
    // first - once that lands, this silent-empty mode becomes structurally
    // impossible for a real production caller. Until then, this is the
    // honest, documented current behavior, not a bug this task fixes.
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');

      const claimed = await claimOne(ctxFor(clientId, client), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });

      expect(claimed).toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const job = await getJob(pool, jobId);
    expect(job.status).toBe('queued');
  });
});
