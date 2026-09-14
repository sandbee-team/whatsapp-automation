import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from '../queue/index.js';
import {
  cleanupProbeClients,
  ctxFor,
  DEFAULT_CLAIM_INPUT,
  getJob,
  seedJob,
  seedTenant,
  type TestPool,
} from '../queue/__tests__/claim-test-helpers.js';
import { materialiseMaxRate, resolveRateMinor, UnpricedKeyError } from './pricing.js';

/**
 * pricing.integration.test.ts (P18 Unit U2) - real-Postgres proofs that a
 * client override beats the default price list, that a pricing change
 * materialised in the same transaction is what the very next `claimOne`
 * sees (ADR 0019 S11 - `wallet.repo.ts`'s doc comment on why this must be
 * one transaction), and that changing pricing never reprices a past ledger
 * row (append-only, ADR 0019 S11).
 */

let pool: TestPool;
let tenantDb: ReturnType<typeof createTenantDb>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

async function insertClientPricing(clientId: string, overrideItems: Record<string, number>) {
  await pool.query(
    `INSERT INTO client_pricing (client_id, price_list_key, override_items)
     VALUES ($1, 'default_inr', $2::jsonb)`,
    [clientId, JSON.stringify(overrideItems)],
  );
}

afterEach(async () => {
  await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('client pricing overrides', () => {
  it('client_override_beats_the_default_price_list', async () => {
    const { clientId } = await seedTenant(pool, probeClientIds);
    await insertClientPricing(clientId, { text: 7 });

    const textRate = await tenantDb.withTenant(clientId, (tx) =>
      resolveRateMinor(tx, clientId, 'text'),
    );
    expect(textRate).toBe(7);

    const mediaRate = await tenantDb.withTenant(clientId, (tx) =>
      resolveRateMinor(tx, clientId, 'media'),
    );
    expect(mediaRate).toBe(25);

    const { clientId: unpricedClientId } = await seedTenant(pool, probeClientIds);
    await expect(
      tenantDb.withTenant(unpricedClientId, (tx) => resolveRateMinor(tx, unpricedClientId, 'text')),
    ).rejects.toBeInstanceOf(UnpricedKeyError);
  });
});

describe('pricing change takes effect on the very next claim', () => {
  it('pricing_change_takes_effect_on_the_very_next_claim', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds, {
      balanceMinor: 20,
      maxRateMinor: 15,
    });
    await insertClientPricing(clientId, {});
    const jobId = await seedJob(pool, { clientId, instanceId });

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query(
        `UPDATE client_pricing SET override_items = '{"media":40,"group_media":40}'::jsonb WHERE client_id = $1`,
        [clientId],
      );
      const maxRate = await materialiseMaxRate(tx, clientId);
      expect(maxRate).toBe(40);
    });

    const walletAfterFirst = await pool.query<{ max_rate_minor: string }>(
      'SELECT max_rate_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(walletAfterFirst.rows[0]?.max_rate_minor).toBe('40');

    const claimedAfterFirst = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(claimedAfterFirst).toBeUndefined();
    const jobAfterFirst = await getJob(pool, jobId);
    expect(jobAfterFirst.status).toBe('queued');

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query(
        `UPDATE client_pricing SET override_items = '{"text":5,"media":5,"group_text":5,"group_media":5}'::jsonb WHERE client_id = $1`,
        [clientId],
      );
      const maxRate = await materialiseMaxRate(tx, clientId);
      expect(maxRate).toBe(5);
    });

    const walletAfterSecond = await pool.query<{ max_rate_minor: string }>(
      'SELECT max_rate_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(walletAfterSecond.rows[0]?.max_rate_minor).toBe('5');

    const claimedAfterSecond = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(claimedAfterSecond?.id).toBe(jobId);
  });
});

describe('a pricing change never reprices a past ledger row', () => {
  it('a_pricing_change_never_reprices_a_past_ledger_row', async () => {
    const { clientId } = await seedTenant(pool, probeClientIds, {
      balanceMinor: 1000,
      maxRateMinor: 15,
    });
    await insertClientPricing(clientId, {});

    await pool.query(
      `INSERT INTO wallet_ledger
         (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor,
          quantity, actor_type)
       VALUES ($1, 1, 'debit_send', -15, 985, 'text', 15, 1, 'system')`,
      [clientId],
    );

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query(
        `UPDATE client_pricing SET override_items = '{"text":999,"media":999,"group_text":999,"group_media":999}'::jsonb WHERE client_id = $1`,
        [clientId],
      );
      await materialiseMaxRate(tx, clientId);
    });

    const ledgerRow = await pool.query<{ rate_minor: string; balance_after_minor: string }>(
      `SELECT rate_minor::text, balance_after_minor::text
         FROM wallet_ledger WHERE client_id = $1 AND seq = 1`,
      [clientId],
    );
    expect(ledgerRow.rows[0]?.rate_minor).toBe('15');
    expect(ledgerRow.rows[0]?.balance_after_minor).toBe('985');
  });
});
