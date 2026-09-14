import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { fetchWindowRow, toCount } from './signals/window-row.js';
import type { CollectCtx } from './signals/types.js';

/**
 * collectors.integration.test.ts (P16 Unit B) - real PG. Proves the
 * `cancel_reason = 'opt_out'` exclusion rule holds against
 * `health-signal-windows.sql`'s own message_jobs-derived aggregates
 * (`sent_24h`/`cold_sent_24h`/`eligible_sent_24h`), which `cold_outreach_
 * ratio` and `delivery_ratio` read. Fake clock injected via `now` - never
 * real wall-clock timing.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'health-collectors-test',
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

async function seedSentJob(
  clientId: string,
  instanceId: string,
  options: { isNewConversation: boolean; cancelReason?: string | null; sentAt: Date },
): Promise<void> {
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  await pool.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation, sent_at, cancel_reason)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 3, 'sent', now(), now(),
             1, 5, $5, $6, $7)`,
    [
      clientId,
      instanceId,
      recipientJid,
      JSON.stringify({ text: 'hello' }),
      options.isNewConversation,
      options.sentAt,
      options.cancelReason ?? null,
    ],
  );
}

describe('health collectors integration', () => {
  it('opt_out_cancelled_jobs_are_excluded_from_every_denominator', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);

    // Two legitimately-sent jobs (one cold, one warm), plus one job that
    // WOULD count as a cold send but is cancelled with cancel_reason =
    // 'opt_out' - it must contribute to NEITHER numerator NOR denominator.
    const sentAt = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago, > 30min old for delivery_ratio eligibility
    await seedSentJob(clientId, instanceId, { isNewConversation: true, sentAt });
    await seedSentJob(clientId, instanceId, { isNewConversation: false, sentAt });
    await seedSentJob(clientId, instanceId, {
      isNewConversation: true,
      cancelReason: 'opt_out',
      sentAt,
    });

    await tenantDb.withTenant(clientId, async (tx) => {
      const ctx: CollectCtx = { sql: tx, instanceId, clientId, now: () => NOW };
      const row = await fetchWindowRow(ctx);

      // sent_24h (cold_outreach_ratio's/opt_out_rate's shared denominator)
      // must exclude the opt_out row entirely: 2, not 3.
      expect(toCount(row.sent_24h)).toBe(2);
      // cold_sent_24h (cold_outreach_ratio's numerator) must exclude the
      // opt_out cold row: 1, not 2.
      expect(toCount(row.cold_sent_24h)).toBe(1);
      // eligible_sent_24h (delivery_ratio's denominator) must also exclude
      // the opt_out row: 2, not 3.
      expect(toCount(row.eligible_sent_24h)).toBe(2);
    });
  });
});
