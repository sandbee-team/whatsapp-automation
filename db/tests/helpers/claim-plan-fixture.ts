import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ensureAllPartitions } from '../../src/index.js';

/**
 * Shared seed-fixture machinery for `claim-plan.test.ts`, split out at the
 * max-lines cap (same idiom as `partition-fixtures.ts`) - pure DB-access
 * helpers only, no assertions here, those stay in the test file.
 *
 * Bucket-derivation background (P07 debug follow-up 2026-08-31, generalized
 * 2026-09-01 - see claim-plan.test.ts's own header for the original
 * data-dependent-Sort-node fixture-shape research): the assertion iterates
 * `message_jobs_claim_idx`'s CHILD indexes straight from the catalog (every
 * existing monthly partition), so the set of partitions THIS fixture seeds
 * must always equal that set, however many exist on any given day - never a
 * hardcoded month count, else an older leftover partition Seq-Scans empty
 * (correct for zero rows) and the test's own substring assertion fails.
 */

export const INSTANCE_COUNT = 15;
export const JOBS_PER_INSTANCE = 300;
export const PROBE_FENCE = 7;

interface BucketBound {
  bucket: number;
  p_start: string;
  p_cap: string;
}

/** Every ACTUAL partition of `message_jobs` right now, by catalog inheritance - not a hardcoded month count. */
async function fetchMessageJobsPartitionNames(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_catalog.pg_inherits inh
       JOIN pg_catalog.pg_class c ON c.oid = inh.inhrelid
      WHERE inh.inhparent = 'message_jobs'::regclass
      ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.relname);
}

/**
 * Parses each `message_jobs_yYYYYmMM` partition name (the exact naming
 * convention `wp_ensure_month_partition` - db/migrations/0003 - uses, and
 * the only stable, non-ambient source of truth for a partition's month:
 * parsing `pg_get_expr(relpartbound, oid)`'s free-text bound expression
 * would be a second, more fragile way to say the same thing) into a
 * `{ p_start, p_cap }` UTC bucket bound. The CURRENT month's bucket is
 * capped at `now()` (its rows must stay claimable: `next_attempt_at`,
 * `scheduled_at` <= now() for the probe to return a row). Every OTHER
 * month - future or past - is capped at `p_start + 20 days`: a future
 * month's rows are never claimable (correct - they only exist so that
 * partition's index gets real rows, not a Seq Scan), and a past month's
 * `p_start + 20 days` is automatically <= now() too (the whole month is
 * behind us), so no special-casing is needed for a partition older than
 * the current month or for a year boundary (31 Dec: year and month are
 * read independently, so Dec -> Jan is just a normal `YYYY` digit change).
 */
function bucketsFromPartitionNames(partitionNames: string[]): BucketBound[] {
  const nowUtc = new Date();
  const currentYear = nowUtc.getUTCFullYear();
  const currentMonth = nowUtc.getUTCMonth() + 1;

  return partitionNames.map((relname, bucket) => {
    const match = /^message_jobs_y(\d{4})m(\d{2})$/.exec(relname);
    if (!match) {
      throw new Error(`unexpected message_jobs partition name shape: ${relname}`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const pStart = new Date(Date.UTC(year, month - 1, 1));
    const isCurrentMonth = year === currentYear && month === currentMonth;
    const pCap = isCurrentMonth ? nowUtc : new Date(Date.UTC(year, month - 1, 1 + 20));
    return { bucket, p_start: pStart.toISOString(), p_cap: pCap.toISOString() };
  });
}

export interface SeedPlanRepresentativeFixtureOptions {
  /**
   * P23 U3 - when true, inserts one RUNNING `campaigns` row for this probe
   * client/instance and stamps the probe instance's own high-band
   * (`priority_rank=10`) queued jobs with its id, so the claim's `campaigns`
   * LEFT JOIN is actually exercised (not an always-NULL passthrough) for the
   * exact row `explainClaim` returns (`PROBE_BAND=10`). Defaults to false -
   * every other existing caller keeps every job's `campaign_id` NULL,
   * byte-identical to its prior behaviour.
   */
  withRunningCampaign?: boolean;
}

/**
 * Seeds 1 client x INSTANCE_COUNT instances x JOBS_PER_INSTANCE jobs,
 * spread round-robin across EVERY ACTUAL `message_jobs` partition (see the
 * file header for why), COMMITTED, then ANALYZEs. `ensureAllPartitions`
 * runs first (idempotent) so the current/+1/+2-month partitions exist even
 * against a brand-new/freshly-migrated database with no pre-existing
 * partitions; any OLDER leftover partition is picked up by
 * `fetchMessageJobsPartitionNames` and seeded too, so it is never empty.
 */
export async function seedPlanRepresentativeFixture(
  pool: pg.Pool,
  probeClientIds: string[],
  options: SeedPlanRepresentativeFixtureOptions = {},
): Promise<{ clientId: string; probeInstanceId: string }> {
  await ensureAllPartitions(pool);

  const partitionNames = await fetchMessageJobsPartitionNames(pool);
  const buckets = bucketsFromPartitionNames(partitionNames);
  const bucketCount = buckets.length;

  const clientId = randomUUID();
  probeClientIds.push(clientId);

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1,$2,$3,$4)', [
    clientId,
    'Claim Plan Probe',
    `claim-plan-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1,$2,$3,$4)',
    [clientId, 100_000, 'active', 100],
  );

  let probeInstanceId = '';
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const instanceId = randomUUID();
    if (i === 0) probeInstanceId = instanceId;

    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1,$2,$3,$4,$5)`,
      [instanceId, clientId, `claim-plan-instance-${i}`, 'connected', 0],
    );
    await pool.query(
      'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1,$2,$3)',
      [instanceId, clientId, PROBE_FENCE],
    );
    await pool.query(
      `WITH bucket_bounds AS (
         -- One row per ACTUAL message_jobs partition today (never a
         -- hardcoded month count) - see bucketsFromPartitionNames above for
         -- how $4 is built and why bucket 0 (current month) is capped at
         -- "now" while every other bucket (future OR a leftover past month)
         -- is capped at p_start + 20 days.
         SELECT
           (elem->>'bucket')::int AS bucket,
           (elem->>'p_start')::timestamptz AS p_start,
           (elem->>'p_cap')::timestamptz AS p_cap
         FROM jsonb_array_elements($4::jsonb) AS elem
       ),
       jobs AS (
         -- Round-robin every job across all buckets (n % bucket_count) so
         -- EVERY partition gets real rows regardless of how many exist -
         -- generalizes the old fixed 70/20/10 split, which only worked for
         -- exactly three buckets.
         SELECT n, (n % $5::int) AS bucket
         FROM generate_series(1, $3) AS n
       )
       INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, payload,
          payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at, created_at)
       SELECT
         $1, $2, 0,
         '1555' || lpad(j.n::text, 10, '0') || '@s.whatsapp.net',
         '+1555' || lpad(j.n::text, 10, '0'),
         jsonb_build_object('text', 'claim-plan probe', 'seq', j.n), 'text',
         (CASE j.n % 3 WHEN 0 THEN 'high' WHEN 1 THEN 'normal' ELSE 'low' END)::job_priority,
         (CASE j.n % 3 WHEN 0 THEN 10 WHEN 1 THEN 20 ELSE 30 END)::smallint,
         'queued',
         bb.p_start + make_interval(secs => j.n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)))::int, 1)),
         bb.p_start + make_interval(secs => j.n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)))::int, 1)),
         bb.p_start + make_interval(secs => j.n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)))::int, 1))
       FROM jobs j
       JOIN bucket_bounds bb ON bb.bucket = j.bucket`,
      [clientId, instanceId, JOBS_PER_INSTANCE, JSON.stringify(buckets), bucketCount],
    );

    // P23 U3: stamp the probe instance's own high-band (priority_rank=10,
    // PROBE_BAND) jobs with a real RUNNING campaign so the claim's
    // `campaigns` LEFT JOIN is actually exercised (loops=1) for the exact
    // row `explainClaim` returns - never an always-NULL passthrough.
    if (i === 0 && options.withRunningCampaign) {
      const campaignId = randomUUID();
      await pool.query(
        `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
         VALUES ($1,$2,$3,'running','claim-plan-probe-campaign',
                 '{"kind":"contacts","tagIds":[],"contactIds":[]}'::jsonb,
                 '{"kind":"text","body":"fixture"}'::jsonb)`,
        [campaignId, clientId, instanceId],
      );
      // MANY sibling cancelled campaigns for this SAME client (not a
      // handful): a lone or small-count campaign row set makes
      // campaigns_client_instance_status_idx's client_id-only scan cheaper
      // than a per-row campaign_id-keyed probe, since the LEFT JOIN can just
      // materialize every one of this client's rows and filter in memory.
      // Enough rows per client tips the planner toward the genuine
      // campaign_id-keyed campaigns_pkey lookup the join predicate actually
      // uses (see seedManyCampaignsForCardinality's own comment).
      await pool.query(
        `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
         SELECT gen_random_uuid(), $1, $2, 'cancelled', 'claim-plan-probe-sibling-campaign',
                '{"kind":"contacts","tagIds":[],"contactIds":[]}'::jsonb,
                '{"kind":"text","body":"fixture"}'::jsonb
           FROM generate_series(1, 500)`,
        [clientId, instanceId],
      );
      await pool.query(
        `UPDATE message_jobs SET campaign_id = $3
          WHERE client_id = $1 AND instance_id = $2 AND priority_rank = 10`,
        [clientId, instanceId, campaignId],
      );
      // P23 U3b: a campaign job never exists without a message_job_refs row
      // (ADR 0017 S1) - stamping campaign_id above without this made
      // no_message_job_exists_without_a_matching_ref fail table-wide.
      await pool.query(
        `INSERT INTO message_job_refs (
           public_id, client_id, instance_id, message_job_id, message_job_created_at, dedupe_key
         )
         SELECT gen_random_uuid(), client_id, instance_id, id, created_at, 'claim-plan-probe:' || id::text
           FROM message_jobs
          WHERE client_id = $1 AND instance_id = $2 AND priority_rank = 10`,
        [clientId, instanceId],
      );
    }
  }

  await pool.query('ANALYZE message_jobs');
  await pool.query('ANALYZE campaigns');
  return { clientId, probeInstanceId };
}

/**
 * P19 Unit U3 - seeds MANY (`count`) throwaway client + wallet_accounts rows
 * so `wallet_accounts` stops being the "single page, cheapest as a Seq Scan"
 * table the P03 evidence found it to be (docs/evidence/P03-claim-explain.md
 * point (a), `Seq Scan on wallet_accounts w (cost=0.00..2.05 rows=1)`) and
 * the planner genuinely prefers `wallet_accounts_pkey` for a single-client
 * probe instead. Deliberately NOT pushed through `probeClientIds` (that
 * list drives a byte-for-byte `message_jobs` snapshot compare in some
 * callers) - the caller must clean these up itself via the returned id
 * array. `client_pricing`/`whatsapp_instances` are NOT seeded for these
 * throwaway clients: they exist purely to inflate `wallet_accounts`
 * cardinality, and the claim probe never targets them.
 */
export async function seedManyWalletAccountsForCardinality(
  pool: pg.Pool,
  count: number,
): Promise<string[]> {
  const clientIds = Array.from({ length: count }, () => randomUUID());

  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status)
     SELECT id, 'Wallet Cardinality Probe', 'wallet-cardinality-probe-' || id, 'active'
       FROM unnest($1::uuid[]) AS id`,
    [clientIds],
  );
  await pool.query(
    `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
     SELECT id, 100_000, 'active', 100
       FROM unnest($1::uuid[]) AS id`,
    [clientIds],
  );
  await pool.query('ANALYZE wallet_accounts');

  return clientIds;
}

/**
 * FK-safe cleanup for `seedManyWalletAccountsForCardinality`'s throwaway
 * rows. `VACUUM` after the DELETE (2026-09-14 fix, see claim-plan.test.ts's
 * own afterEach comment for the measured bloat this prevents) - this helper
 * churns 5,000 `wallet_accounts` rows per call, and without reclaiming the
 * dead tuples the table bloats across repeated suite runs in the shared test
 * database exactly like `message_jobs` did.
 */
export async function cleanupManyWalletAccounts(pool: pg.Pool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
  await pool.query('VACUUM wallet_accounts');
  await pool.query('VACUUM clients');
}

// P23 U3 - campaigns cardinality-bump helpers live in the sibling module
// `claim-plan-fixture-campaigns.ts` (split at the max-lines cap) and are
// re-exported here so `claim-plan.test.ts` keeps a single helpers import.
export {
  seedManyCampaignsForCardinality,
  cleanupManyCampaigns,
} from './claim-plan-fixture-campaigns.js';
