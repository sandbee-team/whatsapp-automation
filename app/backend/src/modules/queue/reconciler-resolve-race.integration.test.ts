import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { computeContentHash } from '../../engine/queue/content-hash.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  seedNeedsReconcileJob,
  seedUnresolvedEvidence,
} from './__tests__/reconciler-test-helpers.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from './reconciler.js';

/**
 * reconciler-resolve-race.integration.test.ts (C1 CRITICAL finding 3) -
 * real Postgres. Split out of `reconciler.integration.test.ts` at the
 * `max-lines` cap (sibling-test-file idiom). Proves the two race-condition
 * fixes in `reconciler-resolve.ts#applyResolve`:
 *   - 3(a): a second, colliding echo landing between the pre-filter read and
 *     the resolve transaction must not be resolved as unambiguous.
 *   - 3(b): a lost assignment race (rowCount 0) must never strand the job in
 *     `needs_reconcile` - it either completes (own replay) or takes the
 *     ambiguous path (a different job won), never leaves state untouched.
 * Both races are driven as EXPLICIT, deterministic interleavings (wrapping
 * `tenantDb.withTenant`/`tx.query` to inject the competing write at the
 * exact right moment) - no sleeps, no sampled concurrency.
 */

const RECONCILE_WINDOW_MS = 600_000;
const ECHO_TOLERANCE_MS = 300_000;

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reconciler-resolve-race-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function buildDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps {
  const metrics = bindQueueMetrics(createMetricsRegistry());
  return {
    pool,
    tenantDb,
    metrics,
    sink: { onRepairedSent: vi.fn().mockResolvedValue(undefined) },
    reconcileWindowMs: RECONCILE_WINDOW_MS,
    echoToleranceMs: ECHO_TOLERANCE_MS,
    maxRows: 500,
    now: () => Date.now(),
    ...overrides,
  };
}

describe('runOneReconcilerSweep resolve-branch race conditions (real Postgres)', () => {
  it('a_second_echo_arriving_between_the_scan_and_the_resolve_is_not_resolved_as_unambiguous', async () => {
    // Finding 3(a): the scan's sibling/evidence snapshot is read OUTSIDE the
    // transaction that performs the resolve. Drive the exact interleaving
    // deterministically (no sleeps, no sampled race): let the scan run and
    // return its (stale) single-evidence-row snapshot, then - BEFORE the
    // resolve proceeds - insert a second colliding evidence row, exactly
    // like a real echo replay racing the sweep. The in-transaction re-check
    // must see the now-ambiguous state and refuse to resolve.
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'stale-snapshot-race',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const firstWaMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      waMsgId: firstWaMsgId,
      contentHash,
    });

    const secondWaMsgId = `wamid.${randomUUID()}`;
    let evidenceSelectSeen = false;
    const wrappedTenantDb: TenantDb = {
      withTenant: async (clientId, fn) =>
        tenantDb.withTenant(clientId, async (tx) => {
          const wrappedTx = {
            query: (async (sql: string, params?: unknown[]) => {
              const result = await tx.query(sql, params as never);
              if (
                !evidenceSelectSeen &&
                typeof sql === 'string' &&
                sql.includes('FROM message_wa_ids') &&
                sql.includes('message_id IS NULL')
              ) {
                evidenceSelectSeen = true;
                // The interleaving: the reconciler's evidence lookup has
                // already run and captured a ONE-row snapshot. A second,
                // colliding echo lands NOW - before applyResolve's own
                // transaction performs the assignment UPDATE - exactly the
                // real-world "WhatsApp replays an echo on reconnect" case.
                await seedUnresolvedEvidence(pool, {
                  clientId: seeded.clientId,
                  instanceId: seeded.instanceId,
                  waMsgId: secondWaMsgId,
                  contentHash,
                });
              }
              return result;
            }) as typeof tx.query,
          };
          return fn(wrappedTx as never);
        }),
    };

    const deps = buildDeps({ tenantDb: wrappedTenantDb });
    await runOneReconcilerSweep(deps);

    expect(evidenceSelectSeen).toBe(true);

    // Neither evidence row was assigned - the false-match direction (ADR
    // 0035 §7's "worse" outcome) must never happen.
    const wa = await pool.query<{ message_id: string | null }>(
      'SELECT wa_msg_id, message_id FROM message_wa_ids WHERE client_id = $1 AND instance_id = $2 AND wa_msg_id = ANY($3) ORDER BY wa_msg_id',
      [seeded.clientId, seeded.instanceId, [firstWaMsgId, secondWaMsgId]],
    );
    expect(wa.rows.every((row) => row.message_id === null)).toBe(true);

    const job = await pool.query<{ status: string; unresolved_reason: string | null }>(
      'SELECT status, unresolved_reason FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(job.rows[0]?.unresolved_reason).toBe('ambiguous_echo_match');

    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [seeded.sendAttemptId],
    );
    // The attempt is left dispatched by the ambiguous path (never
    // auto-resolved, never silently abandoned by this branch).
    expect(attempt.rows[0]?.state).toBe('dispatched');
  });

  it('a_lost_assignment_race_for_our_own_job_does_not_strand_the_job', async () => {
    // Finding 3(b), own-replay branch: drive the exact interleaving
    // deterministically. The pre-filter (outside any transaction) still
    // sees the evidence row UNRESOLVED, so decideReconciliation legitimately
    // returns 'resolve' and applyResolve's transaction begins - but a
    // concurrent reconciler run (this job's own earlier/parallel attempt)
    // wins the assignment INSIDE that window, using the exact UPDATE
    // applyResolve itself performs. applyResolve's assignment UPDATE must
    // then lose the race (rowCount 0) against a row that belongs to THIS
    // job, recognise its own id, and complete the remaining writes rather
    // than stranding the job in needs_reconcile.
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'own-replay-race',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const waMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      waMsgId,
      contentHash,
    });

    let ownerCheckSeen = false;
    const wrappedTenantDb: TenantDb = {
      withTenant: async (clientId, fn) =>
        tenantDb.withTenant(clientId, async (tx) => {
          const wrappedTx = {
            query: (async (sql: string, params?: unknown[]) => {
              if (
                !ownerCheckSeen &&
                typeof sql === 'string' &&
                sql.includes('SELECT message_id FROM message_wa_ids')
              ) {
                ownerCheckSeen = true;
                // The interleaving: applyResolve's owner-check is about to
                // run and see the row still unresolved (message_id IS
                // NULL) - a concurrent winner assigns it to THIS job right
                // now, server-side, using the real created_at via a
                // subquery (never a JS-round-tripped Date).
                await pool.query(
                  `UPDATE message_wa_ids SET message_id = $1,
                          message_created_at = (SELECT created_at FROM message_jobs WHERE id = $1 AND client_id = $2)
                    WHERE client_id = $2 AND instance_id = $3 AND direction = 'out' AND wa_msg_id = $4 AND message_id IS NULL`,
                  [seeded.jobId, seeded.clientId, seeded.instanceId, waMsgId],
                );
              }
              return tx.query(sql, params as never);
            }) as typeof tx.query,
          };
          return fn(wrappedTx as never);
        }),
    };

    const deps = buildDeps({ tenantDb: wrappedTenantDb });
    await runOneReconcilerSweep(deps);

    expect(ownerCheckSeen).toBe(true);

    const job = await pool.query<{ status: string; sent_at: Date | null }>(
      'SELECT status, sent_at FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('sent');
    expect(job.rows[0]?.sent_at).not.toBeNull();

    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [seeded.sendAttemptId],
    );
    expect(attempt.rows[0]?.state).toBe('reconciled_sent');
  });

  it('a_lost_assignment_race_to_another_job_takes_the_ambiguous_path', async () => {
    // Finding 3(b), other-job branch: same deterministic interleaving as
    // above, but the concurrent winner is a DIFFERENT job - genuine
    // ambiguity, never left stranded in needs_reconcile.
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'other-job-race',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const otherJob = await seedNeedsReconcileJob(pool, probeClientIds, {
      contentHash: computeContentHash({ jid: '2@s.whatsapp.net', kind: 'text', text: 'unrelated' }),
      existingTenant: { clientId: seeded.clientId, instanceId: seeded.instanceId },
    });
    const waMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      waMsgId,
      contentHash,
    });

    let ownerCheckSeen = false;
    const wrappedTenantDb: TenantDb = {
      withTenant: async (clientId, fn) =>
        tenantDb.withTenant(clientId, async (tx) => {
          const wrappedTx = {
            query: (async (sql: string, params?: unknown[]) => {
              if (
                !ownerCheckSeen &&
                typeof sql === 'string' &&
                sql.includes('SELECT message_id FROM message_wa_ids')
              ) {
                ownerCheckSeen = true;
                // A DIFFERENT job (otherJob) wins the assignment race here.
                await pool.query(
                  `UPDATE message_wa_ids SET message_id = $1,
                          message_created_at = (SELECT created_at FROM message_jobs WHERE id = $1 AND client_id = $2)
                    WHERE client_id = $2 AND instance_id = $3 AND direction = 'out' AND wa_msg_id = $4 AND message_id IS NULL`,
                  [otherJob.jobId, seeded.clientId, seeded.instanceId, waMsgId],
                );
              }
              return tx.query(sql, params as never);
            }) as typeof tx.query,
          };
          return fn(wrappedTx as never);
        }),
    };

    const deps = buildDeps({ tenantDb: wrappedTenantDb });
    await runOneReconcilerSweep(deps);

    expect(ownerCheckSeen).toBe(true);

    const job = await pool.query<{ status: string; unresolved_reason: string | null }>(
      'SELECT status, unresolved_reason FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(job.rows[0]?.unresolved_reason).toBe('ambiguous_echo_match');

    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [seeded.sendAttemptId],
    );
    expect(attempt.rows[0]?.state).toBe('dispatched');
  });
});
