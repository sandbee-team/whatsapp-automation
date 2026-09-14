import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { waJidFromE164 } from '@wp/domain';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { bindInboundMetrics } from './metrics.js';
import { handleInboundMessageSignals, type MessageSignalsDeps } from './message-signals.js';
import { writeInboundDeadLetter, classifyInboundError } from './dead-letter.js';
import {
  cleanupInboundOptoutProbeRows,
  inboundOptoutCandidate,
  makeInboundOptoutProvider,
  seedLiveContact,
  seedQueuedDmJob,
} from './__tests__/optout-inbound-test-support.js';

/**
 * message-signals-c2.integration.test.ts (P21 C2 hardening) - real-Postgres:
 * mid-transaction crash rolls back EVERY write and a clean retry succeeds
 * exactly once; a rejecting post-commit `onOptedOut` port still leaves
 * exactly one committed `opt_outs` row on replay; 10 concurrent identical
 * STOPs collapse to one `opt_outs` row and cancel every queued job exactly
 * once; `writeInboundDeadLetter`'s OWN transaction survives a caller
 * transaction that has just rolled back.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'message-signals-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM inbound_dead_letters WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupInboundOptoutProbeRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Wraps a real `TenantDb`, rejecting the Nth matching `tx.query()` call inside the callback; `withTenant` still owns BEGIN/COMMIT/ROLLBACK so the ROLLBACK is genuine, server-side, never mocked. */
function withInjectedFailure(
  realTenantDb: TenantDb,
  sqlMarker: string,
  failOnNthMatch: number,
): TenantDb {
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      return realTenantDb.withTenant(clientId, async (tx) => {
        let matchCount = 0;
        const wrapped: TenantQueryable = {
          async query<R extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) {
            if (sql.includes(sqlMarker)) {
              matchCount += 1;
              if (matchCount === failOnNthMatch) {
                throw new Error('injected-failure-for-test');
              }
            }
            return tx.query<R>(sql, params);
          },
        };
        return fn(wrapped);
      });
    },
  };
}

function baseDeps(
  overrides: Partial<MessageSignalsDeps> & Pick<MessageSignalsDeps, 'clientId' | 'instanceId'>,
): MessageSignalsDeps {
  const registry = createMetricsRegistry();
  return {
    tenantDb,
    keyProvider: makeInboundOptoutProvider(),
    metrics: bindInboundMetrics(registry),
    metricsRegistry: registry,
    mirror: async () => ({ contactsUpdated: 0 }),
    onOptedOut: async () => {},
    ...overrides,
  };
}

describe('handleInboundMessageSignals - crash mid-transaction (real Postgres)', () => {
  it('a_failure_in_the_tenant_optout_keywords_select_rolls_back_the_whole_transaction_then_a_clean_retry_succeeds_exactly_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220001';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
    const dmJobId = await seedQueuedDmJob(
      pool,
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      phoneHash,
    );

    const crashingTenantDb = withInjectedFailure(tenantDb, 'FROM tenant_optout_keywords', 1);
    const deps = baseDeps({
      clientId,
      instanceId,
      tenantDb: crashingTenantDb,
      keyProvider: provider,
    });

    await expect(
      handleInboundMessageSignals(deps, {
        senderJid: waJidFromE164(e164),
        candidate: inboundOptoutCandidate('STOP'),
      }),
    ).rejects.toThrow('injected-failure-for-test');

    // Every write this transaction attempted before the crash is gone.
    const contactAfterCrash = await pool.query<{ last_inbound_at: Date | null }>(
      'SELECT last_inbound_at FROM contacts WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    expect(contactAfterCrash.rows[0]?.last_inbound_at).toBeNull();

    const ircAfterCrash = await pool.query(
      'SELECT recipient_hash FROM instance_recipient_contacts WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    expect(ircAfterCrash.rowCount).toBe(0);

    const optOutsAfterCrash = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutsAfterCrash.rowCount).toBe(0);

    const jobAfterCrash = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobId],
    );
    expect(jobAfterCrash.rows[0]?.status).toBe('queued');

    // Clean retry of the SAME message, no injected failure: succeeds and
    // writes exactly once.
    const retryOutcome = await handleInboundMessageSignals(
      baseDeps({ clientId, instanceId, keyProvider: provider }),
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate('STOP') },
    );
    expect(retryOutcome).toEqual({ attribution: 'attributed', optedOut: true, touched: true });

    const contactAfterRetry = await pool.query<{ last_inbound_at: Date | null }>(
      'SELECT last_inbound_at FROM contacts WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    expect(contactAfterRetry.rows[0]?.last_inbound_at).not.toBeNull();

    const optOutsAfterRetry = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutsAfterRetry.rowCount).toBe(1);

    const jobAfterRetry = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobId],
    );
    expect(jobAfterRetry.rows[0]?.status).toBe('cancelled');
  });
});

describe('handleInboundMessageSignals - rejecting post-commit port, then replay (real Postgres)', () => {
  it('a_rejecting_onOptedOut_port_still_leaves_exactly_one_optout_row_after_a_replay_of_the_same_stop', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220002';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);

    const deps = baseDeps({
      clientId,
      instanceId,
      keyProvider: provider,
      onOptedOut: async () => {
        throw new Error('confirmation-port-rejected-for-test');
      },
    });

    const first = await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('STOP'),
    });
    expect(first).toEqual({ attribution: 'attributed', optedOut: true, touched: true });

    const second = await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('STOP'),
    });
    // The row-level assertion below is what matters: exactly one row ever.
    expect(second.attribution).toBe('attributed');

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);
  });
});

// The "10 concurrent identical STOPs" case lives in the sibling
// `message-signals-c2-2.integration.test.ts` (max-lines split).

describe('writeInboundDeadLetter - own transaction survives a rolled-back caller (real Postgres)', () => {
  it('a_dead_letter_written_from_inside_a_callback_that_then_throws_still_commits_exactly_one_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    await expect(
      tenantDb.withTenant(clientId, async () => {
        // Invoked from inside a callback whose OUTER transaction rolls back.
        await writeInboundDeadLetter(
          { tenantDb, clientId, instanceId, metrics, logger: { warn: () => {} } },
          {
            waMsgId: 'wamid-c2-own-tx',
            chatJid: null,
            errorClass: classifyInboundError(new Error('forced-for-test')),
            rawSize: null,
          },
        );
        throw new Error('outer-callback-throws-after-dead-letter-write');
      }),
    ).rejects.toThrow('outer-callback-throws-after-dead-letter-write');

    const rows = await pool.query<{ wa_msg_id: string | null }>(
      'SELECT wa_msg_id FROM inbound_dead_letters WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.wa_msg_id).toBe('wamid-c2-own-tx');
  });
});

// The clock/timezone-boundary case and the direct-double-port-call case
// live in the sibling `message-signals-c2-2.integration.test.ts` (same
// max-lines-cap split idiom as `optout.integration.test.ts` /
// `optout-lid-and-body.integration.test.ts`).
