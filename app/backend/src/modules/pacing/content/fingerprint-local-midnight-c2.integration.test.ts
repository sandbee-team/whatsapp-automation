import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { computeFingerprint, evaluateDuplicateFanout } from './fingerprint.js';

/**
 * fingerprint-local-midnight-c2.integration.test.ts (P14 C2 review, clock-
 * boundary lens) - `content_fingerprints`' PK is `(client_id, local_date,
 * fingerprint)` (client-level, per the blueprint - migration 0036 step 1
 * comment), while `local_date` itself is derived PER-INSTANCE from
 * `readGuardPipelineState`'s `(now() AT TIME ZONE s.pacing_timezone)::date`.
 * This file pins two real behaviours (never bounds-only assertions):
 *   1. The SAME `localDate` string, evaluated at 23:59 vs 00:01 of the NEXT
 *      day, is a genuinely different bucket - the distinct-recipient counter
 *      resets daily by design (the guard's own doc comment).
 *   2. Two instances of the SAME client in DIFFERENT timezones, sharing one
 *      fingerprint, do NOT necessarily agree on which client-level
 *      `local_date` row they bump on a given real moment - because the PK is
 *      client-level but `local_date` is computed per-instance, a fingerprint
 *      evaluated near local midnight from two differently-timezoned
 *      instances of the same client can land in two DIFFERENT
 *      `content_fingerprints` rows for the same real-world instant. This is
 *      a documented design wrinkle (phase file step 1: "client-level PK,
 *      *not* instance-level"), pinned here rather than left tacit.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'fp-midnight-c2' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
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

const WARN_AT = 150;
const ACK_AT = 500;

describe('content_fingerprints local_date boundary at instance-local midnight (P14 C2)', () => {
  it('a_recipient_evaluated_at_2359_and_0001_the_next_local_day_lands_in_two_distinct_buckets', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const fingerprint = computeFingerprint('Local midnight boundary fixture body');
    const recipientHash = Buffer.from('c2-midnight-recipient');

    // 23:59 local on day 1.
    const beforeMidnight = new Date('2026-09-02T23:59:00.000Z');
    const decisionBefore = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate: '2026-09-02',
        fingerprint,
        recipientHash,
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now: beforeMidnight,
      }),
    );
    expect(decisionBefore).toEqual({ ok: true });

    // 00:01 local on day 2 - the SAME recipient, SAME fingerprint, but a
    // DIFFERENT local_date bucket. The guard's counter is per (client,
    // local_date, fingerprint), so this recipient counts as a FRESH distinct
    // recipient for the new day's bucket - the daily reset is by design.
    const afterMidnight = new Date('2026-09-03T00:01:00.000Z');
    const decisionAfter = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate: '2026-09-03',
        fingerprint,
        recipientHash,
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now: afterMidnight,
      }),
    );
    expect(decisionAfter).toEqual({ ok: true });

    const rows = await pool.query<{ local_date: string; recipient_count: number }>(
      `SELECT local_date::text AS local_date, recipient_count FROM content_fingerprints
        WHERE client_id = $1 AND fingerprint = $2 ORDER BY local_date`,
      [clientId, fingerprint],
    );
    // TWO separate rows, each with recipient_count = 1 - the day-1 bucket is
    // NOT incremented again by the day-2 evaluation, and vice versa.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.local_date).toBe('2026-09-02');
    expect(rows.rows[0]?.recipient_count).toBe(1);
    expect(rows.rows[1]?.local_date).toBe('2026-09-03');
    expect(rows.rows[1]?.recipient_count).toBe(1);
  });

  it('two_instances_of_one_client_in_different_timezones_can_bump_different_local_date_rows_for_the_same_real_moment', async () => {
    // DOCUMENTED DESIGN WRINKLE (phase file step 1, verbatim): the
    // content_fingerprints PK is CLIENT-level (client_id, local_date,
    // fingerprint), while local_date itself is derived PER-INSTANCE from
    // that instance's own pacing_timezone. Two instances of the SAME client
    // in different timezones therefore do not share one authoritative
    // "today" - each instance's own guard evaluation computes local_date
    // independently and both write into the SAME client-scoped counter
    // family, but as TWO separate rows when their local calendar dates
    // differ at the moment of evaluation. This test pins the actual
    // behaviour (not a bound): the two evaluations, run at the SAME real
    // instant via two different instances' local_date, land in different
    // rows and neither counts toward the other's threshold.
    const { clientId } = await seedSendTenant(pool, probeClientIds, {});
    const tenantDb = createTenantDb(pool);
    const fingerprint = computeFingerprint('Cross-timezone client fixture body');
    const recipientHash = Buffer.from('c2-cross-tz-recipient');

    // Simulate instance A's local_date (e.g. Asia/Kolkata, already past
    // local midnight) vs instance B's local_date (e.g. a UTC-11 zone, still
    // on the previous calendar day) for the SAME real instant - the
    // evaluator takes localDate as an already-resolved string (the caller,
    // readGuardPipelineState, is what actually diverges per-instance in
    // production; this test pins the CONSEQUENCE directly against the
    // evaluator/table contract, which is the part this phase actually
    // owns).
    const now = new Date('2026-09-03T01:00:00.000Z');
    const decisionA = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate: '2026-09-03', // instance A's local calendar date
        fingerprint,
        recipientHash,
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now,
      }),
    );
    const decisionB = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate: '2026-09-02', // instance B's local calendar date (still "yesterday")
        fingerprint,
        recipientHash,
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now,
      }),
    );
    expect(decisionA).toEqual({ ok: true });
    expect(decisionB).toEqual({ ok: true });

    const rows = await pool.query<{ local_date: string; recipient_count: number }>(
      `SELECT local_date::text AS local_date, recipient_count FROM content_fingerprints
        WHERE client_id = $1 AND fingerprint = $2 ORDER BY local_date`,
      [clientId, fingerprint],
    );
    // Pinned wrinkle: TWO rows for what is, from the recipient's point of
    // view, ONE evaluation moment against ONE fingerprint - the same
    // recipient_hash counts as "distinct" in BOTH client-level buckets,
    // because the PK's local_date component disagrees across instances.
    // This is documented, not asserted as a bug: fixing it would require
    // either an instance-level PK (which the blueprint explicitly rejected)
    // or a single client-wide "today" authority that does not exist today.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.recipient_count)).toEqual([1, 1]);
  });
});
