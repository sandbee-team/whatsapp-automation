import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { bindInboundMetrics } from './metrics.js';
import { recordInboundReceipt, type InboundReceipt } from './receipts.js';

/**
 * receipts-c2-huge-batch.integration.test.ts (P21 C2 hardening) - huge-input
 * shape against real Postgres: a `message-receipt.update` batch of 1,000
 * receipts for UNKNOWN wa_msg_ids writes zero rows, zero dead letters, and
 * counts `wp_receipt_unmatched_total` +1000 exactly.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'receipts-c2-huge-batch-test',
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

function unknownDeliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1',
    participantJid: '',
  };
}

describe('recordInboundReceipt - 1000 receipts for unknown wa_msg_ids (real Postgres)', () => {
  it('a_batch_of_1000_receipts_for_unknown_ids_writes_zero_rows_zero_dead_letters_and_counts_unmatched_1000_times', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcomes: string[] = [];
    for (let i = 0; i < 1000; i++) {
      outcomes.push(
        await recordInboundReceipt(
          deps,
          unknownDeliveredReceipt(`UNKNOWN-${randomUUID()}-${String(i)}`),
        ),
      );
    }

    expect(outcomes.filter((o) => o === 'unmatched')).toHaveLength(1000);
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1000);

    const deliveryRows = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      clientId,
    ]);
    expect(deliveryRows.rowCount).toBe(0);

    const deadLetters = await tenantDb.withTenant(clientId, (tx) =>
      tx.query('SELECT id FROM inbound_dead_letters WHERE client_id = $1', [clientId]),
    );
    expect(deadLetters.rowCount).toBe(0);
  }, 60_000);
});
