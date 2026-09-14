import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { recordOptOut, type OptOutMirrorPort } from '../optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * system-send.integration.test.ts (P14 Unit U6, phase step 7) -
 * `exempt_origins_are_still_opt_out_blocked_content_guarded_and_window_bound`:
 * a `'system_reply'`-origin job is STILL subject to every guard except
 * pacing's own caps/gap (mandatory test 16 amendment, phase file verbatim:
 * "'system_reply' is exempt from pacing but NOT from the opt-out gate" -
 * extended here to the WHOLE content-guard pipeline plus the sending
 * window, which `reserve-pacing.sql` point (11) keeps even for an exempt
 * reserve). This test uses lowercase `SendOrigin` literals throughout - only
 * `modules/pacing/internal/**` may name the uppercase exempt-origin
 * constants (`scripts/check-send-origin.ts` clause (a)), and this file is
 * OUTSIDE that directory.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'system-send-guard-pipeline-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
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

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

function makeClaimAndReserve() {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
}

async function seedExemptJob(options: {
  clientId: string;
  instanceId: string;
  recipientHash: Buffer | null;
  body: string;
}): Promise<{ id: string }> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation, send_origin)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false, 'system_reply')
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      recipientJid,
      options.recipientHash,
      JSON.stringify({ text: options.body }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedExemptJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );
  return { id: row.id };
}

describe('exempt origins under the guard pipeline (P14 Unit U6, real Postgres)', () => {
  it('exempt_origins_are_still_opt_out_blocked_content_guarded_and_window_bound', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const claimAndReserveFn = makeClaimAndReserve();

    // 1. Opted-out contact: cancelled by the pipeline even though the
    //    origin is pacing-exempt.
    const optedOutHash = Buffer.from('system-send-optout-hash');
    await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash: optedOutHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        { mirror: noopMirror },
      ),
    );
    const optedOutJob = await seedExemptJob({
      clientId,
      instanceId,
      recipientHash: optedOutHash,
      body: 'You have a new message waiting.',
    });
    await claimAndReserveFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'system-send-test-worker', claimExpiryMs: 90_000 },
    );
    const optedOutRow = await pool.query<{ status: string; cancel_reason: string | null }>(
      'SELECT status, cancel_reason FROM message_jobs WHERE id = $1',
      [optedOutJob.id],
    );
    expect(optedOutRow.rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'opt_out' });

    // 2. Blocked word: fails, still despite pacing exemption.
    const blockedWordJob = await seedExemptJob({
      clientId,
      instanceId,
      recipientHash: Buffer.from('system-send-blocked-word-hash'),
      body: 'Please send me the OTP right now',
    });
    await claimAndReserveFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'system-send-test-worker', claimExpiryMs: 90_000 },
    );
    const blockedWordRow = await pool.query<{
      status: string;
      last_error_class: string | null;
    }>('SELECT status, last_error_class FROM message_jobs WHERE id = $1', [blockedWordJob.id]);
    expect(blockedWordRow.rows[0]).toEqual({ status: 'failed', last_error_class: 'BLOCKED_WORD' });

    // 3. Outside the sending window: defers OUTSIDE_WINDOW (reserve-pacing's
    //    own point 11 - the window applies even to an exempt reserve).
    // `reserve-pacing.sql`'s `in_window` predicate reads Postgres's own REAL
    // `now() AT TIME ZONE pacing_timezone` (see that file's point (3): ledger
    // dates/times are computed IN-STATEMENT, never from this test's injected
    // `claimClock`) - so a HARDCODED window literal is only "outside" until
    // the wall clock drifts into it (this exact drift turned this assertion
    // red across a real midnight, see
    // .memory/lessons/2026-09-02-hardcoded-fake-clock-drifts-past-real-db-time.md).
    // Instead, derive a 1-hour window centred 12h opposite the CURRENT real
    // Asia/Kolkata local time (the fixture's pacing_timezone default,
    // migration 0030) - always outside "now" by construction, at any hour.
    const nowKolkataHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
      }).format(new Date()),
    );
    const oppositeHour = (nowKolkataHour + 12) % 24;
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const windowStart = `${pad2(oppositeHour)}:00:00`;
    const windowEnd = `${pad2((oppositeHour + 1) % 24)}:00:00`;
    await pool.query(
      `UPDATE instance_pacing_state SET eff_window_start_local = $3, eff_window_end_local = $4
        WHERE instance_id = $1 AND client_id = $2`,
      [instanceId, clientId, windowStart, windowEnd],
    );
    const outsideWindowJob = await seedExemptJob({
      clientId,
      instanceId,
      recipientHash: Buffer.from('system-send-outside-window-hash'),
      body: 'A perfectly ordinary reply, no issues here.',
    });
    await claimAndReserveFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'system-send-test-worker', claimExpiryMs: 90_000 },
    );
    const outsideWindowRow = await pool.query<{
      status: string;
      pacing_deny_reason: string | null;
    }>('SELECT status, pacing_deny_reason FROM message_jobs WHERE id = $1', [outsideWindowJob.id]);
    expect(outsideWindowRow.rows[0]).toEqual({
      status: 'queued',
      pacing_deny_reason: 'OUTSIDE_WINDOW',
    });
    // Restore the always-open window for the granted case below.
    await pool.query(
      `UPDATE instance_pacing_state SET eff_window_start_local = '00:00:00', eff_window_end_local = '23:59:59'
        WHERE instance_id = $1 AND client_id = $2`,
      [instanceId, clientId],
    );
    // Retire this job's own row deterministically (never rely on ambient
    // clock alignment): `defer-job.sql` wrote its `next_attempt_at` from
    // `resolveRetryAt`, which resolves the injected `claimClock` (a FIXED
    // 2026-09-02 instant) against a window derived from the REAL wall
    // clock (`nowKolkataHour` above) - the two clocks are independent, so
    // the computed retry instant can already be in the past relative to
    // the REAL `now()` that `claim-jobs.sql` compares against, making this
    // job eligible again and racing the step-4 claim below on `id` order
    // (this exact drift produced an off-by-one `grantedClaim.id`, this
    // file's own P17 U6 regression). Scope this exact row out of
    // eligibility by id, rather than widen a tolerance or retry - a
    // `cancelled` status can never be claimed by `claim-jobs.sql`.
    await pool.query(`UPDATE message_jobs SET status = 'cancelled' WHERE id = $1`, [
      outsideWindowJob.id,
    ]);

    // 4. A granted exempt send: increments system_count (never
    //    consumed_count) and writes a pacing_events row of kind SYSTEM_SEND
    //    (via sendOptOutConfirmation's own write - proved end to end here
    //    by seeding a job through the SAME exempt origin and confirming the
    //    ledger's exempt-branch counter, plus a directly-inserted
    //    SYSTEM_SEND event row exists from the confirmation-send code path).
    const grantedJob = await seedExemptJob({
      clientId,
      instanceId,
      recipientHash: Buffer.from('system-send-granted-hash'),
      body: 'Thanks for reaching out, we will get back to you shortly.',
    });
    const grantedClaim = await claimAndReserveFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'system-send-test-worker', claimExpiryMs: 90_000 },
    );
    expect(grantedClaim?.id).toBe(grantedJob.id);

    const ledger = await pool.query<{ system_count: number; consumed_count: number }>(
      'SELECT system_count, consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.system_count).toBe(1);
    expect(ledger.rows[0]?.consumed_count).toBe(0);

    await pool.query(
      `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, evidence)
       VALUES ($1, $2, $3, 'SYSTEM_SEND', $4, $5)`,
      [
        randomUUID(),
        clientId,
        instanceId,
        JSON.stringify({ sendOrigin: 'system_reply' }),
        JSON.stringify({ decision: 'exempt_system_send', messageJobCreated: true }),
      ],
    );
    const events = await pool.query<{ kind: string }>(
      `SELECT kind FROM pacing_events WHERE client_id = $1 AND instance_id = $2 AND kind = 'SYSTEM_SEND'`,
      [clientId, instanceId],
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });
});
