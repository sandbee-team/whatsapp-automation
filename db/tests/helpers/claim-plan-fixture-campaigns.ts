import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * P23 U3 - `campaigns` cardinality-bump fixture helpers, split out of
 * `claim-plan-fixture.ts` at the max-lines cap (same idiom as
 * `session-worker-discovery-wiring.ts`/`session-cost-feedback-timer.ts` -
 * a sibling module, not a shrunk comment). Pure DB-access helpers only, no
 * assertions here, those stay in `claim-plan.test.ts`.
 */

/**
 * Seeds MANY (`count`) throwaway client + whatsapp_instances + campaigns
 * rows (10 campaigns per throwaway client, all set-based) so `campaigns`
 * stops being the trivially-empty table docs/evidence/
 * P19-claim-explain-wallet.md found it as (a legitimate `Seq Scan on
 * campaigns` for zero rows) and the planner genuinely prefers
 * `campaigns_pkey` for a single-row, campaign_id-keyed probe instead. 10
 * campaigns per client (not 1): a single campaign per client makes
 * `client_id` alone as selective as `id`, biasing the planner toward
 * `campaigns_client_instance_status_idx` instead. Every throwaway campaign
 * is `status='cancelled'` (outside the allow-list) so none is ever confused
 * with the probe's own RUNNING campaign (seeded separately by
 * `seedPlanRepresentativeFixture`'s `withRunningCampaign` option). Not
 * pushed through `probeClientIds`, same reason as
 * `seedManyWalletAccountsForCardinality` - caller cleans up.
 */
export async function seedManyCampaignsForCardinality(
  pool: pg.Pool,
  count: number,
): Promise<string[]> {
  const clientIds = Array.from({ length: count }, () => randomUUID());

  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status)
     SELECT id, 'Campaign Cardinality Probe', 'campaign-cardinality-probe-' || id, 'active'
       FROM unnest($1::uuid[]) AS id`,
    [clientIds],
  );
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     SELECT gen_random_uuid(), id, 'campaign-cardinality-instance', 'connected', 0
       FROM unnest($1::uuid[]) AS id`,
    [clientIds],
  );
  await pool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
     SELECT gen_random_uuid(), c.id, i.id, 'cancelled', 'campaign-cardinality-probe',
            '{"kind":"contacts","tagIds":[],"contactIds":[]}'::jsonb,
            '{"kind":"text","body":"fixture"}'::jsonb
       FROM unnest($1::uuid[]) AS c(id)
       JOIN whatsapp_instances i ON i.client_id = c.id
       CROSS JOIN generate_series(1, 10)`,
    [clientIds],
  );
  await pool.query('ANALYZE campaigns');

  return clientIds;
}

/**
 * FK-safe cleanup for `seedManyCampaignsForCardinality`'s throwaway rows.
 * `VACUUM` after the DELETE (2026-09-14 fix, see claim-plan.test.ts's own
 * afterEach comment for the measured bloat this prevents) - this helper
 * churns 5,000 `campaigns` client/instance rows and 50,000 `campaigns` rows
 * per call; measured live at 63,142 `campaigns` heap pages for ~500 real
 * rows before this fix, purely from repeated unreclaimed DELETEs across
 * suite runs in the shared test database.
 */
export async function cleanupManyCampaigns(pool: pg.Pool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
  await pool.query('VACUUM campaigns');
  await pool.query('VACUUM whatsapp_instances');
  await pool.query('VACUUM clients');
}
