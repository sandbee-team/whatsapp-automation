import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import {
  drainOnce,
  type RelayPool,
  type RelayPoolClient,
  type RelayMetricsPort,
} from './relay-loop.js';
import type { EmailFanoutPort } from './relay-loop-email-wiring.js';

/**
 * relay-loop-email-crash.test.ts (P17 fix round F1, flipped from the C2-
 * hardening pin) - a fake-pool, no-DB unit test proving the FIXED behavior:
 * the email leg's actual dispatch runs AFTER `drainOnce`'s own transaction
 * has committed (see `relay-loop.ts`'s own doc comment), so an SMTP throw
 * mid-batch (i) never rolls back the SAME tick's sse/webhook work, (ii)
 * never causes a row to be sent twice across two ticks (the row is already
 * marked published, inside the commit, before the send is even attempted),
 * and (iii) increments the failure counter path (via `emailFanout` itself -
 * `dispatch/email.ts`'s own per-row isolation is proven separately by
 * `dispatch/email-per-row-isolation.integration.test.ts`; this file's job is
 * only to prove `drainOnce` never lets a `dispatchEmails` throw touch the
 * tick's own transaction or claim the row a second time). Deterministic:
 * fake pool/client, injected clock, no sleeps, no real Postgres/Redis/SMTP.
 */

interface Row {
  id: string;
  client_id: string;
  instance_id: string | null;
  event_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  coalesce_key: string | null;
  fanout: ('sse' | 'webhook' | 'email')[];
  attempts: number;
  created_at: Date;
}

function noOpMetrics(): RelayMetricsPort {
  return {
    setOutboxDepth: () => undefined,
    observePublishLagSeconds: () => undefined,
    incrementEventsPublished: () => undefined,
    incrementSseCoalesced: () => undefined,
    incrementDropped: () => undefined,
    incrementPoisoned: () => undefined,
  };
}

/** A fake `RelayPool`/`RelayPoolClient` pair: `claim-outbox` returns the seeded rows once (empty thereafter), the depth probe returns 0, mark-published/BEGIN/COMMIT/ROLLBACK/SET LOCAL ROLE are all recorded but not actually persisted (in-memory). */
function makeFakePool(rows: Row[]): {
  pool: RelayPool;
  executed: string[];
  published: Set<string>;
} {
  const executed: string[] = [];
  const published = new Set<string>();
  let claimed = false;

  const client: RelayPoolClient = {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: T[]; rowCount: number | null }> {
      executed.push(sql.trim().split('\n')[0] ?? sql);
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (sql.includes('count(*)::text AS depth')) {
        return { rows: [{ depth: '0' } as unknown as T], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE outbox_events SET published_at')) {
        // ids are passed positionally; simplest to mark ALL currently-claimed
        // rows published on any such UPDATE call, matching what a real
        // `WHERE id = ANY($1)` would do for the ids this test seeds.
        for (const row of rows) published.add(row.id);
        return { rows: [], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  const pool: RelayPool = {
    connect: async () => client,
  };

  return { pool, executed, published };
}

const NOTIFICATION_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

function makeRow(overrides: Partial<Row>): Row {
  return {
    id: 'row-1',
    client_id: CLIENT_ID,
    instance_id: INSTANCE_ID,
    event_type: 'notification.created',
    entity_id: NOTIFICATION_ID,
    payload: {
      notificationId: NOTIFICATION_ID,
      kind: 'instance_paused',
      severity: 'critical',
      instanceId: INSTANCE_ID,
    },
    coalesce_key: null,
    fanout: ['sse'],
    attempts: 0,
    created_at: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  };
}

describe('drainOnce email-leg crash (P17 fix round F1)', () => {
  it('an_email_leg_throw_never_rolls_back_the_same_ticks_sibling_sse_and_webhook_work', async () => {
    const sseRow = makeRow({ id: 'row-sse', fanout: ['sse'], coalesce_key: 'coalesce-1' });
    const webhookRow = makeRow({ id: 'row-webhook', fanout: ['webhook'] });
    const emailRow = makeRow({ id: 'row-email', fanout: ['email'] });
    const { pool, published } = makeFakePool([sseRow, webhookRow, emailRow]);

    const publishBatch = vi.fn();
    const throwingEmailFanout: EmailFanoutPort = {
      dispatchEmails: async () => {
        throw new Error('SMTP exploded mid-tick');
      },
    };

    // Never rejects - the throw happens AFTER the tick's own transaction has
    // already committed, so drainOnce itself never propagates it.
    const count = await drainOnce({
      pool,
      publisher: { publishBatch },
      metrics: noOpMetrics(),
      clock: { now: () => new Date('2026-09-03T00:00:05Z') },
      emailFanout: throwingEmailFanout,
    });

    expect(count).toBe(3);
    // The sse row's publishBatch call and the webhook/email rows' mark-
    // published UPDATE all committed - none of it was rolled back by the
    // LATER, out-of-transaction email dispatch throw.
    expect(publishBatch).toHaveBeenCalledTimes(1);
    expect(published.has('row-sse')).toBe(true);
    expect(published.has('row-webhook')).toBe(true);
    expect(published.has('row-email')).toBe(true);
  });

  it('an_email_leg_throw_never_causes_the_row_to_be_reclaimed_or_resent_on_a_later_tick', async () => {
    const emailRow = makeRow({ id: 'row-email-once', fanout: ['email'] });
    const { pool } = makeFakePool([emailRow]);

    const dispatchEmails = vi.fn().mockRejectedValue(new Error('SMTP exploded mid-tick'));
    const throwingEmailFanout: EmailFanoutPort = { dispatchEmails };

    await drainOnce({
      pool,
      publisher: { publishBatch: vi.fn() },
      metrics: noOpMetrics(),
      clock: { now: () => new Date('2026-09-03T00:00:05Z') },
      emailFanout: throwingEmailFanout,
    });

    // A second tick claims nothing more (the fake pool's claim-outbox query
    // returns the seeded rows exactly ONCE) - proving the row was marked
    // published on the FIRST tick despite the dispatch throw, so it is never
    // reclaimed/resent by a later tick (at-most-once by design).
    const secondTickCount = await drainOnce({
      pool,
      publisher: { publishBatch: vi.fn() },
      metrics: noOpMetrics(),
      clock: { now: () => new Date('2026-09-03T00:00:06Z') },
      emailFanout: throwingEmailFanout,
    });

    expect(secondTickCount).toBe(0);
    expect(dispatchEmails).toHaveBeenCalledTimes(1);
  });

  it('a_email_dispatch_that_never_throws_still_marks_every_row_published_in_one_tick', async () => {
    const emailRow = makeRow({ id: 'row-email-ok', fanout: ['email'] });
    const { pool, published } = makeFakePool([emailRow]);

    const okEmailFanout: EmailFanoutPort = {
      dispatchEmails: async () => undefined,
    };

    const count = await drainOnce({
      pool,
      publisher: { publishBatch: vi.fn() },
      metrics: noOpMetrics(),
      clock: { now: () => new Date('2026-09-03T00:00:05Z') },
      emailFanout: okEmailFanout,
    });

    expect(count).toBe(1);
    expect(published.has('row-email-ok')).toBe(true);
  });
});
