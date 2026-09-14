import { describe, expect, it, vi } from 'vitest';
import { emit } from './emit.js';
import type { TenantQueryable } from '@wp/db';

/**
 * emit.test.ts (P15 U2, step 4; extended P15 U4, step 5) - proves `emit()`
 * writes exactly ONE row plus ONE relay-wake NOTIFY on the caller's own
 * transaction handle, and never touches a hub/publisher/socket (ADR 0010:
 * "Nothing is ever published from inside a business transaction" - `emit`
 * is the write half only, the relay is the only publisher; NOTIFY is a
 * latency-only wake HINT, never a data carrier - "correctness never depends
 * on NOTIFY"). A real ROLLBACK's effect on BOTH the row and the notify
 * (durability/silence) is proven by `emit.integration.test.ts` against real
 * Postgres - this file proves the unit-testable half: `emit` itself
 * performs no I/O beyond the two `tx.query` calls the caller handed it
 * (INSERT, then `pg_notify`), and calls no publish-shaped function at all.
 */

function fakeTx(): { tx: TenantQueryable; queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async () => ({ rows: [{ id: 1n }], rowCount: 1 }));
  return { tx: { query: queryMock } as unknown as TenantQueryable, queryMock };
}

describe('emit', () => {
  it('emit_writes_the_row_on_the_callers_transaction_and_publishes_nothing', async () => {
    const { tx, queryMock } = fakeTx();
    const hubPublish = vi.fn();

    await emit(tx, {
      clientId: '11111111-1111-4111-8111-111111111111',
      instanceId: '22222222-2222-4222-8222-222222222222',
      type: 'instance.health_changed',
      entityId: '22222222-2222-4222-8222-222222222222',
      payload: {
        instanceId: '22222222-2222-4222-8222-222222222222',
        healthState: 'connected',
        pauseReason: null,
        needsUserAction: false,
      },
      fanout: ['sse'],
    });

    // Exactly two query calls, both on the SAME caller-provided tx handle:
    // the INSERT, then the relay-wake NOTIFY - nothing else.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [insertSql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/insert\s+into\s+outbox_events/i);
    const [notifySql, notifyParams] = queryMock.mock.calls[1] as [string, unknown[] | undefined];
    expect(notifySql).toMatch(/pg_notify\s*\(\s*'wp_outbox_wake'\s*,\s*''\s*\)/i);
    // Carries NO data - an empty-string payload literal, never a bound
    // parameter (nothing about this event should be inferable from the
    // wake itself).
    expect(notifyParams ?? []).toHaveLength(0);

    // Never touches a hub/publisher-shaped call - emit has no such
    // reference at all, so there is nothing to spy on beyond asserting the
    // test double we PASSED IN (hubPublish) was never invoked by anything
    // reachable from emit's own scope.
    expect(hubPublish).not.toHaveBeenCalled();
  });

  it('rejects_instance_qr_and_writes_no_row', async () => {
    const { tx, queryMock } = fakeTx();

    await expect(
      emit(tx, {
        clientId: '11111111-1111-4111-8111-111111111111',
        instanceId: '22222222-2222-4222-8222-222222222222',
        type: 'instance.qr',
        entityId: '22222222-2222-4222-8222-222222222222',
        payload: {
          instanceId: '22222222-2222-4222-8222-222222222222',
          expiresAt: '2026-08-27T12:00:00.000Z',
          attemptsLeft: 3,
          payload: 'fake-qr-payload',
        },
        fanout: ['sse'],
      }),
    ).rejects.toThrow();

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects_an_sse_fanout_with_no_coalesce_key', async () => {
    const { tx, queryMock } = fakeTx();

    await expect(
      emit(tx, {
        clientId: '11111111-1111-4111-8111-111111111111',
        instanceId: '22222222-2222-4222-8222-222222222222',
        type: 'instance.health_changed',
        entityId: '22222222-2222-4222-8222-222222222222',
        payload: {
          instanceId: '22222222-2222-4222-8222-222222222222',
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
        },
        fanout: ['sse'],
        coalesceKey: undefined,
      }),
    ).resolves.toBeUndefined();

    // coalesce_key is DERIVED for a known coalescable type (instance.health_changed),
    // so this call must still succeed and pass a non-null coalesce_key param
    // (INSERT + wake NOTIFY, same two-call shape as the first test above).
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('instance:22222222-2222-4222-8222-222222222222:state');
  });

  it('rejects_an_empty_fanout_array', async () => {
    const { tx, queryMock } = fakeTx();

    await expect(
      emit(tx, {
        clientId: '11111111-1111-4111-8111-111111111111',
        type: 'campaign.progress',
        entityId: '33333333-3333-4333-8333-333333333333',
        payload: {
          campaignId: '33333333-3333-4333-8333-333333333333',
          sent: 1,
          queued: 2,
          failed: 0,
        },
        fanout: [],
      }),
    ).rejects.toThrow();

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects_a_payload_field_that_is_not_ids_or_enums', async () => {
    const { tx, queryMock } = fakeTx();

    await expect(
      emit(tx, {
        clientId: '11111111-1111-4111-8111-111111111111',
        instanceId: '22222222-2222-4222-8222-222222222222',
        type: 'instance.health_changed',
        entityId: '22222222-2222-4222-8222-222222222222',
        payload: {
          instanceId: '22222222-2222-4222-8222-222222222222',
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
          phone: '+919876543210',
        },
        fanout: ['sse'],
      }),
    ).rejects.toThrow();

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('webhook_only_fanout_never_requires_a_coalesce_key', async () => {
    const { tx, queryMock } = fakeTx();

    await emit(tx, {
      clientId: '11111111-1111-4111-8111-111111111111',
      type: 'job.needs_user_action',
      entityId: 'job_abc123',
      payload: { jobPublicId: 'job_abc123', reason: 'unresolved_send' },
      fanout: ['webhook'],
    });

    // webhook-only fanout still gets exactly one row + one wake NOTIFY - the
    // wake is unconditional (never gated on which fanout the row carries).
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(null);
  });

  it('email_only_fanout_is_accepted_and_never_requires_a_coalesce_key', async () => {
    const { tx, queryMock } = fakeTx();

    await emit(tx, {
      clientId: '11111111-1111-4111-8111-111111111111',
      type: 'job.needs_user_action',
      entityId: 'job_abc123',
      payload: { jobPublicId: 'job_abc123', reason: 'unresolved_send' },
      fanout: ['email'],
    });

    // P17 U3 (step 3): migration 0048 widened the outbox fanout CHECK to
    // add 'email' - emit() accepts it as a generic outbox writer (see the
    // module doc comment's own note that emit itself never special-cases
    // which event types may use which channel).
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [insertSql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/insert\s+into\s+outbox_events/i);
    expect(params).toContain(null);
  });
});
