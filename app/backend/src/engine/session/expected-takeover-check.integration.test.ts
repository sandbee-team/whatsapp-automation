import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  buildRunner,
  type PublishMock,
} from './runner-test-support.js';
import { buildExpectedTakeoverCheck } from './expected-takeover-check.js';

/**
 * expected-takeover-check.integration.test.ts (P09 U6 step 9, carried-
 * forward P08 handoff) - proves the REAL `expectedTakeoverCheck` predicate
 * (`buildExpectedTakeoverCheck`, backed by `instance_lease_state`) both
 * directions, driven through the real runner's 440/`session_replaced` close
 * handling (mirrors `runner-disconnect.edge.integration.test.ts`'s own
 * `a_440_expected_takeover_close_calls_sock_end_exactly_once` composition,
 * but with the REAL predicate wired in instead of a hand-fed
 * `vi.fn().mockResolvedValue(true)`).
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

function withTenantOverPool(): Parameters<typeof buildExpectedTakeoverCheck>[0]['withTenant'] {
  return async (_clientId, fn) => fn(pool as unknown as Parameters<typeof fn>[0]);
}

describe('expectedTakeoverCheck (real instance_lease_state predicate) via the runner 440 path', () => {
  it('expected_takeover_suppresses_the_pause', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });

    // Simulate a REAL takeover: a higher fence minted just now (a genuine
    // lease-mint would write both current_fence and lease_seen_at together -
    // this direct UPDATE stands in for that, matching the row shape
    // lease-mint-fence.sql produces).
    await pool.query(
      `UPDATE instance_lease_state SET current_fence = $1, lease_seen_at = now()
        WHERE instance_id = $2 AND client_id = $3`,
      [(fence + 1n).toString(), instanceId, clientId],
    );

    const expectedTakeoverCheck = buildExpectedTakeoverCheck({ withTenant: withTenantOverPool() });

    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      expectedTakeoverCheck: vi.fn(expectedTakeoverCheck),
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });

    // end_socket ran (side effect for the expected-takeover branch), no pause.
    expect(sock.end).toHaveBeenCalledTimes(1);
    const row = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('connected');
    expect(row.rows[0]?.user_action_reason).toBeNull();
  });

  it('unexpected_440_still_pauses', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    // No takeover happened: instance_lease_state stays exactly as seedProbe
    // left it (current_fence === fence, the same fence this runner holds).

    const expectedTakeoverCheck = buildExpectedTakeoverCheck({ withTenant: withTenantOverPool() });

    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      expectedTakeoverCheck: vi.fn(expectedTakeoverCheck),
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    await sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });

    // Unchanged pause behavior (sideEffects: ['audit', 'notify'], no
    // 'end_socket') - the FSM's own `session_replaced`-not-expected branch,
    // see session-fsm.ts.
    const row = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');
    expect(row.rows[0]?.user_action_reason).toBe('SESSION_REPLACED');
  });
});
