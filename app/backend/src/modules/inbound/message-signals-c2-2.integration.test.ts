import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { waJidFromE164 } from '@wp/domain';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { bindOptOutConfirmationSender } from '../pacing/index.js';
import { syncOptOutMirror } from '../contacts/index.js';
import { bindInboundMetrics } from './metrics.js';
import { handleInboundMessageSignals, type MessageSignalsDeps } from './message-signals.js';
import {
  cleanupInboundOptoutProbeRows,
  inboundOptoutCandidate,
  makeInboundOptoutProvider,
  seedLiveContact,
  seedQueuedDmJob,
} from './__tests__/optout-inbound-test-support.js';

/**
 * message-signals-c2-2.integration.test.ts (P21 C2 hardening, part 2 -
 * max-lines split from `message-signals-c2.integration.test.ts`, same idiom
 * as `optout.integration.test.ts`/`optout-lid-and-body.integration.test.ts`)
 * - 10 truly concurrent identical STOPs from one sender; the clock/timezone
 * boundary case (`first_inbound_at`/`last_inbound_at` across a session
 * TimeZone change); and the direct-double-invocation proof that
 * `bindOptOutConfirmationSender`'s confirmation-job insert is idempotent per
 * opt-out even when the port itself is called twice.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'message-signals-c2-2-test',
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

describe('handleInboundMessageSignals - 10 concurrent identical STOPs (real Postgres)', () => {
  it('ten_concurrent_identical_stops_from_one_sender_write_exactly_one_optout_row_and_cancel_every_queued_job_exactly_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220003';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);

    const dmJobIds = await Promise.all(
      Array.from({ length: 4 }, () =>
        seedQueuedDmJob(
          pool,
          clientId,
          instanceId,
          `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
          phoneHash,
        ),
      ),
    );

    const deps = baseDeps({ clientId, instanceId, keyProvider: provider });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleInboundMessageSignals(deps, {
          senderJid: waJidFromE164(e164),
          candidate: inboundOptoutCandidate('STOP'),
        }),
      ),
    );
    expect(outcomes.every((o) => o.attribution === 'attributed')).toBe(true);

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);

    for (const jobId of dmJobIds) {
      const status = await pool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(status.rows[0]?.status).toBe('cancelled');
      expect(status.rows[0]?.attempts).toBe(0);
    }

    const cancelledCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1 AND status = 'cancelled'`,
      [clientId],
    );
    expect(cancelledCount.rows[0]?.n).toBe(4);
  }, 30_000);
});

describe('handleInboundMessageSignals - clock/timezone boundary (real Postgres)', () => {
  it('last_inbound_at_is_monotonic_and_first_inbound_at_unchanged_across_a_session_timezone_change_between_two_inbound_events', async () => {
    // A dedicated single-connection pool: `max: 1` guarantees `withTenant`'s
    // `pool.connect()` reuses the SAME physical connection both times below,
    // so a `SET TIME ZONE` issued on this pool is guaranteed to be visible
    // to the very next `withTenant` call (a shared multi-connection pool
    // gives no such guarantee - `pool.query()` could land on any connection).
    const singleConnPool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'message-signals-c2-tz-test',
      max: 1,
    });
    const singleConnTenantDb = createTenantDb(singleConnPool);
    try {
      const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
      const provider = makeInboundOptoutProvider();
      const e164 = '+15552220004';
      const phoneHash = hashRecipient(provider, e164);
      await seedLiveContact(pool, clientId, e164, phoneHash);

      // `set_config('TimeZone', ..., false)` (session-scoped, `is_local=false`)
      // is the accepted functional form of a plain `SET` (same idiom
      // `withTenant` itself uses for `app.client_id` with `is_local=true`) -
      // this dedicated single-connection throwaway pool is the one
      // documented case where a session-scoped GUC change is deliberate and
      // safe (no other tenant can ever share this pool's one connection).
      await singleConnPool.query(`SELECT set_config('TimeZone', 'Asia/Kolkata', false)`);
      await handleInboundMessageSignals(
        baseDeps({ clientId, instanceId, keyProvider: provider, tenantDb: singleConnTenantDb }),
        { senderJid: waJidFromE164(e164), candidate: null },
      );

      const afterFirst = await pool.query<{
        first_inbound_at: Date;
        last_inbound_at: Date;
      }>(
        `SELECT irc.first_inbound_at, c.last_inbound_at
           FROM instance_recipient_contacts irc
           JOIN contacts c ON c.client_id = irc.client_id AND c.phone_hash = irc.recipient_hash
          WHERE irc.client_id = $1 AND irc.instance_id = $2`,
        [clientId, instanceId],
      );
      const firstInboundAt = afterFirst.rows[0]?.first_inbound_at;
      const lastInboundAtAfterFirst = afterFirst.rows[0]?.last_inbound_at;
      expect(firstInboundAt).toBeDefined();
      expect(lastInboundAtAfterFirst).toBeDefined();

      await singleConnPool.query(`SELECT set_config('TimeZone', 'America/New_York', false)`);
      await handleInboundMessageSignals(
        baseDeps({ clientId, instanceId, keyProvider: provider, tenantDb: singleConnTenantDb }),
        { senderJid: waJidFromE164(e164), candidate: null },
      );

      const afterSecond = await pool.query<{
        first_inbound_at: Date;
        last_inbound_at: Date;
      }>(
        `SELECT irc.first_inbound_at, c.last_inbound_at
           FROM instance_recipient_contacts irc
           JOIN contacts c ON c.client_id = irc.client_id AND c.phone_hash = irc.recipient_hash
          WHERE irc.client_id = $1 AND irc.instance_id = $2`,
        [clientId, instanceId],
      );

      // `timestamptz` stores one absolute instant regardless of the session
      // TimeZone GUC used to compute it - the exact instant must be identical
      // (first_inbound_at never moves) and last_inbound_at must be >= the
      // first observation (monotonic), never earlier.
      expect(afterSecond.rows[0]?.first_inbound_at.getTime()).toBe(firstInboundAt?.getTime());
      expect(afterSecond.rows[0]?.last_inbound_at.getTime()).toBeGreaterThanOrEqual(
        lastInboundAtAfterFirst?.getTime() ?? 0,
      );
    } finally {
      await singleConnPool.end();
    }
  });
});

describe('bindOptOutConfirmationSender - direct double invocation is idempotent (real Postgres)', () => {
  it('the_real_syncOptOutMirror_records_opted_out_and_the_confirmation_port_writes_exactly_one_row_even_when_invoked_twice_directly', async () => {
    // Distinct from the "replay of the same STOP through
    // handleInboundMessageSignals" case in the sibling file: here the SAME
    // optedOut payload is handed to `bindOptOutConfirmationSender`'s real
    // port TWICE directly, proving the confirmation-job insert itself is
    // idempotent per opt-out - not merely "the caller happens not to call
    // it twice".
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220005';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);

    const outcome = await handleInboundMessageSignals(
      baseDeps({ clientId, instanceId, keyProvider: provider, mirror: syncOptOutMirror }),
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate('STOP') },
    );
    expect(outcome.optedOut).toBe(true);

    const confirmationPort = bindOptOutConfirmationSender({ tenantDb }, { error: () => {} });
    confirmationPort({ clientId, instanceId, phoneHash, e164 });
    confirmationPort({ clientId, instanceId, phoneHash, e164 });

    // Fire-and-forget port (see optout.integration.test.ts's own note on the
    // same idiom): poll the real write it produces rather than asserting on
    // any wall-clock margin.
    await vi.waitFor(async () => {
      const confirmationRows = await pool.query(
        'SELECT phone_hash FROM optout_confirmations WHERE client_id = $1',
        [clientId],
      );
      expect(confirmationRows.rowCount).toBe(1);
    });
  });
});
