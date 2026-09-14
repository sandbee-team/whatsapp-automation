import { randomBytes, randomUUID } from 'node:crypto';
import { PG_ENUMS } from '@wp/domain';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * schema-assertions-broadcast.test.ts (P23 broadcast-campaigns, Unit U1) -
 * sibling of `schema-assertions.test.ts` (293/300 lines, over the max-lines
 * cap headroom for new assertions - same "split into a sibling module"
 * idiom this repo already uses elsewhere). Every probe row this file
 * creates is cleaned up in its own `afterEach` (shared dev DB, permanent
 * fixture rows).
 */
describe('schema_assertions_broadcast', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    for (const clientId of probeClientIds) {
      await pool.query('DELETE FROM campaign_recipients WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM campaign_counters WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM campaigns WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
    probeClientIds = [];
  });

  async function seedProbeTenant(): Promise<{ clientId: string; instanceId: string }> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const slug = `schema-assertions-broadcast-${clientId}`;
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Schema Assertions broadcast Probe',
      slug,
    ]);
    await pool.query('INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [
      instanceId,
      clientId,
      `${slug}-instance`,
    ]);
    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  it('campaign_recipients_is_not_partitioned_and_its_unique_index_is_real', async () => {
    const pool = await getMigratedPool();

    const partitionedRow = await pool.query(
      `SELECT 1 FROM pg_catalog.pg_partitioned_table pt
         JOIN pg_catalog.pg_class c ON c.oid = pt.partrelid
        WHERE c.relname = 'campaign_recipients'`,
    );
    expect(partitionedRow.rows).toEqual([]);

    const indexRow = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'campaign_recipients' AND indexname = 'cr_campaign_target_uq'`,
    );
    expect(indexRow.rows).toHaveLength(1);
    expect(indexRow.rows[0]?.indexdef).toContain('UNIQUE');
    expect(indexRow.rows[0]?.indexdef).toContain('COALESCE(contact_id, group_id)');

    const { clientId, instanceId } = await seedProbeTenant();
    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, client_id, status, instance_id, name, audience, message)
         VALUES ($1, $2, 'draft', $3, 'probe', '{}'::jsonb, '{}'::jsonb)`,
      [campaignId, clientId, instanceId],
    );
    const contactId = randomUUID();
    await pool.query(
      `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
         VALUES ($1, $2, '+15550000001', $3, '15550000001@s.whatsapp.net', 'manual')`,
      [contactId, clientId, randomBytes(32)],
    );

    const insertRecipient = () =>
      pool.query(
        `INSERT INTO campaign_recipients (client_id, campaign_id, contact_id, recipient_jid, recipient_hash)
           VALUES ($1, $2, $3, '15550000001@s.whatsapp.net', $4)`,
        [clientId, campaignId, contactId, randomBytes(32)],
      );

    await insertRecipient();
    await expect(insertRecipient()).rejects.toMatchObject({ code: '23505' });

    await pool.query('DELETE FROM campaign_recipients WHERE client_id = $1', [clientId]);
    await pool.query('DELETE FROM contacts WHERE client_id = $1', [clientId]);
  });

  it('no_message_job_exists_without_a_matching_ref', async () => {
    const pool = await getMigratedPool();

    const catalog = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'message_job_refs' AND indexname IN ('mjr_dedupe_uq', 'mjr_idem_uq')`,
    );
    expect(catalog.rows.map((row) => row.indexname).sort()).toEqual([
      'mjr_dedupe_uq',
      'mjr_idem_uq',
    ]);

    // Data half: scoped to campaign jobs only - the permanent explain fixture
    // seeds message_jobs rows with no campaign_id and legitimately no ref.
    const orphanCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM message_jobs j
         LEFT JOIN message_job_refs r
           ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE j.campaign_id IS NOT NULL AND r.public_id IS NULL`,
    );
    expect(orphanCount.rows[0]?.count).toBe('0');
  });

  it('deferred_is_not_a_stored_recipient_status', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'broadcast_recipient_status'
        ORDER BY e.enumsortorder`,
    );
    const labels = result.rows.map((row) => row.label);

    expect(labels).toEqual([
      'pending',
      'skipped',
      'queued',
      'sent',
      'delivered',
      'read',
      'failed',
      'cancelled',
    ]);
    expect(labels).not.toContain('deferred');
    expect(labels).toEqual([...PG_ENUMS.broadcast_recipient_status]);
  });

  it('plan_limits_max_broadcast_recipients_defaults_to_20000', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{
      column_default: string | null;
      is_nullable: 'YES' | 'NO';
    }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'plan_limits'
          AND column_name = 'max_broadcast_recipients'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
    expect(result.rows[0]?.column_default).toContain('20000');
  });

  it('campaign_tables_carry_fillfactor_and_aggressive_autovacuum', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions
         FROM pg_catalog.pg_class
        WHERE relname IN ('campaigns', 'campaign_recipients', 'campaign_counters')`,
    );
    const byName = new Map(result.rows.map((row) => [row.relname, row.reloptions ?? []]));

    const campaignsOpts = byName.get('campaigns') ?? [];
    expect(campaignsOpts).toContain('fillfactor=80');
    expect(campaignsOpts.some((opt) => opt.startsWith('autovacuum_vacuum_scale_factor='))).toBe(
      true,
    );
    expect(campaignsOpts.some((opt) => opt.startsWith('autovacuum_vacuum_threshold='))).toBe(true);
    expect(campaignsOpts.some((opt) => opt.startsWith('autovacuum_analyze_scale_factor='))).toBe(
      true,
    );

    const recipientsOpts = byName.get('campaign_recipients') ?? [];
    expect(recipientsOpts).toContain('fillfactor=80');

    const countersOpts = byName.get('campaign_counters') ?? [];
    expect(countersOpts).toContain('fillfactor=70');
    expect(countersOpts.some((opt) => opt.startsWith('autovacuum_vacuum_scale_factor='))).toBe(
      true,
    );
  });

  it('campaigns_funnel_discovery_idx_is_partial_on_the_four_in_flight_statuses', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'campaigns' AND indexname = 'campaigns_funnel_discovery_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    const indexdef = result.rows[0]?.indexdef ?? '';
    expect(indexdef).toContain('WHERE');
    expect(indexdef).toContain(
      "(status = ANY (ARRAY['snapshotting'::broadcast_status, 'expanding'::broadcast_status, 'running'::broadcast_status, 'paused'::broadcast_status]))",
    );
  });
});
