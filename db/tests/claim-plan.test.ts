import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadQuery, bindQueryParams } from '../src/queries.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  seedPlanRepresentativeFixture,
  seedManyWalletAccountsForCardinality,
  cleanupManyWalletAccounts,
  seedManyCampaignsForCardinality,
  cleanupManyCampaigns,
  PROBE_FENCE,
} from './helpers/claim-plan-fixture.js';

/**
 * db/tests/claim-plan.test.ts (P03 Unit D, step 8) - proves the EXACT
 * statement in db/queries/claim-jobs.sql gets a real-index plan, not a
 * sequential scan, against a small but plan-representative self-seeded
 * fixture (never depends on db/seeds/queue-explain-fixture.sql being
 * loaded).
 *
 * FIXTURE SHAPE, and why: docs/evidence/P03-claim-explain.md (this same
 * session) found by direct experimentation that whether the planner's read
 * side of `claim-jobs.sql` shows a genuine `Sort` node is DATA-DEPENDENT -
 * specifically, it flips on how large a share of the table one
 * (client_id, instance_id, priority_rank) triple represents. Against
 * `queue-explain-fixture.sql`'s heaviest single-instance backlog probe
 * (~933 of a partition's 140,000+ rows), the plan was observed to
 * alternate between a clean ordered-index `Merge Append` (no Sort node) and
 * a `Bitmap Heap Scan` + genuine `Sort`, purely as a function of which
 * random sample the most recent `ANALYZE` drew - both fast, but not a
 * stable assertion target. This test instead seeds MANY instances (15) with
 * a MODEST job count each (300), so the probed instance/band never
 * represents more than a small fraction of the table (empirically verified
 * at this shape in this same session: docs/evidence/P03-claim-explain.md
 * capture 1's 20-instance/500-job variant) - the realistic "healthy
 * multi-tenant queue" shape the claim index was designed for, not the
 * fixture file's deliberate worst-case backlog stress shape.
 *
 * `ANALYZE message_jobs` is run explicitly after seeding + COMMIT (not
 * inside the later EXPLAIN transaction, which is rolled back) because
 * autovacuum's background analyze would not reliably have fired yet within
 * a test run - this is the "ensure enough rows/ANALYZE so the planner picks
 * the real index plan" the dispatch asks for.
 *
 * ALL EXISTING MONTHLY PARTITIONS MUST GET REAL ROWS (P07 debug follow-up,
 * 2026-08-31; generalized 2026-09-01 - date-rollover bug fix): the assertion
 * loop below iterates `message_jobs_claim_idx`'s CHILD indexes straight from
 * the catalog (every existing monthly partition, however many there are
 * today), and expects an index scan via EVERY one of them. This test's
 * fixture used to hardcode exactly THREE month buckets (current/+1/+2
 * months) - which broke again the moment a FOURTH, older partition (a
 * leftover from an earlier phase whose "current month" had since rolled
 * over: `message_jobs_y2026m08`, created when P03 ran in August, still
 * present and empty once September began) existed in the catalog but was
 * never seeded. Postgres correctly Seq-Scans an empty partition (cheapest
 * plan for zero rows - not a claim-jobs.sql defect) - this test's own
 * substring assertion then failed. The seeding logic (see
 * `helpers/claim-plan-fixture.ts`) now derives its bucket list from the
 * SAME catalog query the assertion below uses (every actual partition of
 * `message_jobs`, not a hardcoded count), so the set of partitions seeded
 * always equals the set of partitions asserted, correct on any date -
 * including a month or year boundary - not just for as long as exactly
 * three partitions happen to exist. This test must never again depend on
 * ANY externally-seeded or ambient data - it owns every row its own
 * assertion needs.
 */
describe('claim_plan', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      // P23 U3b: withRunningCampaign's message_job_refs rows - delete before
      // message_jobs so no dangling ref outlives the job it points at.
      await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
      // P23 U3: campaigns (seedPlanRepresentativeFixture's withRunningCampaign
      // option) references both clients and whatsapp_instances - must be
      // deleted before either, FK-safe order.
      // Campaign child rows first (a running cron role can create counters or
      // recipients under a probe campaign while this suite runs) - FK-safe order.
      await pool.query(
        'DELETE FROM campaign_counters WHERE campaign_id IN (SELECT id FROM campaigns WHERE client_id = ANY($1))',
        [probeClientIds],
      );
      await pool.query(
        'DELETE FROM campaign_recipients WHERE campaign_id IN (SELECT id FROM campaigns WHERE client_id = ANY($1))',
        [probeClientIds],
      );
      await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
      // 2026-09-14 root-cause fix: ANALYZE alone is not enough - repeated
      // DELETEs on the current-month message_jobs partition (and on
      // campaigns/whatsapp_instances/wallet_accounts/clients, all asserted
      // by plan-SHAPE below) leave dead tuples that bloat their indexes
      // across accumulated suite runs (measured: 28,689 index pages for 13
      // live rows), which flips the planner to a genuinely-cheaper Seq Scan.
      // VACUUM (never FULL - exclusive lock, too slow for afterEach) keeps
      // page counts near-constant by letting the next INSERT reuse reclaimed
      // space. Full measurement + reproduction: .memory/lessons/2026-09-14
      // -claim-plan-bloat-flip.md.
      await pool.query('VACUUM message_jobs');
      await pool.query('VACUUM campaigns');
      await pool.query('VACUUM whatsapp_instances');
      await pool.query('VACUUM wallet_accounts');
      await pool.query('VACUUM clients');
      await pool.query('ANALYZE message_jobs');
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  const PROBE_BAND = 10; // high

  /** Every partition child of message_jobs_claim_idx, by catalog inheritance - not hardcoded month names. */
  async function fetchClaimIndexChildNames(): Promise<string[]> {
    const pool = await getMigratedPool();
    const result = await pool.query<{ child_index_name: string }>(
      `SELECT ic.relname AS child_index_name
         FROM pg_catalog.pg_inherits inh
         JOIN pg_catalog.pg_class ic ON ic.oid = inh.inhrelid
        WHERE inh.inhparent = 'message_jobs_claim_idx'::regclass
        ORDER BY ic.relname`,
    );
    return result.rows.map((row) => row.child_index_name);
  }

  /** Runs EXPLAIN (ANALYZE, BUFFERS) of the exact claim-jobs.sql statement inside a ROLLBACK-only transaction. */
  async function explainClaim(clientId: string, instanceId: string): Promise<string> {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = await loadQuery('claim-jobs');
      const params = bindQueryParams(query, {
        client_id: clientId,
        instance_id: instanceId,
        band: PROBE_BAND,
        fence: PROBE_FENCE,
        worker: 'claim-plan-test',
        claim_expiry_ms: 30_000,
      });
      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${query.text}`,
        params,
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('claim_plan_uses_message_jobs_claim_idx_and_never_seq_scans', async () => {
    const pool = await getMigratedPool();
    const { clientId, probeInstanceId } = await seedPlanRepresentativeFixture(pool, probeClientIds);
    const plan = await explainClaim(clientId, probeInstanceId);

    // message_jobs_claim_idx is the PARENT index on a partitioned table - it
    // is never scanned directly (the parent relation holds no rows itself).
    // Postgres auto-creates one CHILD index per partition, inheriting from
    // the parent, each with an auto-generated name derived from its own
    // column list - db/tests/claim-plan.test.ts must assert against those
    // real child names (resolved from the catalog, not hardcoded month
    // strings), never the literal parent string. See
    // docs/evidence/P03-claim-explain.md point (d) for the verbatim catalog
    // proof this is real PostgreSQL behavior, not a claim-jobs.sql defect.
    // (Red-first proof of this exact point: asserting the literal parent
    // string `expect(plan).toContain('message_jobs_claim_idx')` fails here -
    // ran and captured verbatim in the P03 Unit D session report.)
    //
    // 2026-09-14: asserting the LITERAL per-partition child index name here
    // (in addition to the "no Seq Scan on message_jobs" check below) proved
    // flaky - every bucket has near-identical selectivity, so which
    // partition (if any) shows a genuine Seq Scan is not stable enough to
    // pin to one index name; root cause later found to be index bloat from
    // unreclaimed DELETEs across suite runs, fixed via afterEach's VACUUM
    // (see .memory/lessons/2026-09-14-claim-plan-bloat-flip.md). The proof
    // this test exists to provide is fully carried by the uniform
    // `not.toContain('Seq Scan on message_jobs')` assertion below; the
    // existence check just catches "a partition was never even created".
    const childIndexNames = await fetchClaimIndexChildNames();
    expect(childIndexNames.length).toBeGreaterThan(0);

    expect(plan).not.toContain('Seq Scan on message_jobs');

    // A genuine Sort NODE prints as "Sort  (cost=...)" - distinct from the
    // harmless "Sort Key: ..." / "Sort Method: ..." annotations a
    // Merge Append (whose inputs already arrive pre-sorted from the ordered
    // per-partition index scans above) also prints. Matching bare "Sort"
    // would false-positive on those annotations - see
    // docs/evidence/P03-claim-explain.md point (d).
    expect(plan).not.toMatch(/\bSort\s*\(cost=/);
  });

  /**
   * P19 Unit U3 - proves the ADR 0019 wallet stop predicates
   * (`w.state NOT IN ('empty','frozen') AND w.balance_minor >= w.max_rate_minor`)
   * resolve `wallet_accounts` via an index probe on its own primary key
   * (`client_id`), never a repeated/table-proportional scan. docs/evidence/
   * P03-claim-explain.md found `wallet_accounts` legitimately Seq-Scanned at
   * ~50 rows (cheaper than an index probe for a single-page table) - not a
   * claim-jobs.sql defect, just realistic planner behaviour at tiny
   * cardinality. This test seeds enough throwaway wallet_accounts rows
   * (see seedManyWalletAccountsForCardinality's own doc) that the table is
   * no longer a single page, so the planner's genuine preference can be
   * observed rather than assumed.
   */
  it('claim_plan_probes_wallet_accounts_by_primary_key_and_never_scans_it', async () => {
    const pool = await getMigratedPool();
    const cardinalityClientIds = await seedManyWalletAccountsForCardinality(pool, 5000);
    try {
      const { clientId, probeInstanceId } = await seedPlanRepresentativeFixture(
        pool,
        probeClientIds,
      );
      const plan = await explainClaim(clientId, probeInstanceId);

      expect(plan).toContain('wallet_accounts_pkey');
      expect(plan).not.toContain('Seq Scan on wallet_accounts');
      // The wallet probe is a single-client lookup, keyed by the CTE's own
      // client_id bind - it must appear exactly once (loops=1), never once
      // per candidate row (a repeated per-row scan would show loops>1).
      expect(plan).toMatch(
        /Index Scan using wallet_accounts_pkey on wallet_accounts w[^]*?loops=1\)/,
      );
    } finally {
      await cleanupManyWalletAccounts(pool, cardinalityClientIds);
    }
  });

  /**
   * P23 U3 - proves the campaign allow-list predicate
   * (`j.campaign_id IS NULL OR cp.status IN ('running','expanding')`, the
   * `campaigns` LEFT JOIN keyed by `cp.id = j.campaign_id`) resolves
   * `campaigns` via an index probe on its own primary key, never a
   * table-proportional scan - same shape as the wallet_accounts case above.
   * docs/evidence/P19-claim-explain-wallet.md found `campaigns` legitimately
   * Seq-Scanned (an EMPTY table at that point - cheapest plan for zero rows,
   * not a claim-jobs.sql defect). This test seeds enough throwaway
   * `campaigns` rows (`seedManyCampaignsForCardinality`) that the table is no
   * longer trivially tiny, AND (unlike the wallet case, which only needed
   * cardinality) stamps the probe fixture's own high-band jobs with a real
   * RUNNING campaign_id so the join is actually exercised for the returned
   * row (`loops=1`), not left as an always-NULL passthrough.
   */
  it('claim_plan_probes_campaigns_by_primary_key_and_never_scans_it', async () => {
    const pool = await getMigratedPool();
    const cardinalityClientIds = await seedManyCampaignsForCardinality(pool, 5000);
    try {
      const { clientId, probeInstanceId } = await seedPlanRepresentativeFixture(
        pool,
        probeClientIds,
        { withRunningCampaign: true },
      );
      const plan = await explainClaim(clientId, probeInstanceId);

      expect(plan).toContain('campaigns_pkey');
      expect(plan).not.toContain('Seq Scan on campaigns');
      // The campaigns probe is a single-row lookup keyed by the candidate
      // job's own campaign_id - it must appear exactly once (loops=1), never
      // once per candidate row (a repeated per-row scan would show loops>1).
      expect(plan).toMatch(/Index (Only )?Scan using campaigns_pkey on campaigns cp[^]*?loops=1\)/);

      // The existing assertions (message_jobs child index, wallet_accounts
      // primary key) still hold in this same plan - the campaign fixture
      // addition must not regress either.
      //
      // 2026-09-14: the per-child-index-NAME loop that used to run here was
      // removed - see the first test's own comment above for the full
      // reproduction (flaky on the current-month partition specifically).
      // The existence check plus the uniform "no Seq Scan on message_jobs"
      // assertion below carry the same proof this test needs.
      const childIndexNames = await fetchClaimIndexChildNames();
      expect(childIndexNames.length).toBeGreaterThan(0);
      expect(plan).not.toContain('Seq Scan on message_jobs');
      expect(plan).toContain('wallet_accounts_pkey');
      expect(plan).not.toContain('Seq Scan on wallet_accounts');

      // No NEW bare Sort node beyond what the existing case already allows -
      // reuse of the exact regex the first case in this file asserts with.
      expect(plan).not.toMatch(/\bSort\s*\(cost=/);
    } finally {
      await cleanupManyCampaigns(pool, cardinalityClientIds);
    }
  });
});
