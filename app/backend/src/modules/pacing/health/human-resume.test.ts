import { describe, expect, it, vi } from 'vitest';
import { humanResume } from './human-resume.js';
import type { UserActor } from './transitions.js';

/**
 * human-resume.test.ts (P16 Unit C) - `humanResume` is the ONLY function
 * that can take `health_state` out of `'paused'` (see this module's own
 * doc). Proves: (a) the write is scoped to the caller's `UserActor`-typed
 * argument (a `SystemActor`/`ApiKeyActor` is a compile-time error at the
 * call site, matching `transitions.ts`'s own `exitPaused` pattern), (b) the
 * exact columns written and their post-resume values, (c) it never writes
 * audit/outbox/wake itself (that is the HTTP layer's job, per this unit's
 * dispatch).
 */

function fakeTx(rowCount = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount });
  return { query };
}

const USER_ACTOR: UserActor = { type: 'user', userId: 'user-1' };

describe('humanResume', () => {
  it('writes_health_state_degraded_clears_pause_fields_scoped_to_client_and_instance', async () => {
    const tx = fakeTx();

    await humanResume(tx, {
      clientId: 'client-1',
      instanceId: 'instance-1',
      actor: USER_ACTOR,
    });

    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE\s+whatsapp_instances/i);
    expect(sql).toMatch(/health_state\s*=\s*'degraded'/i);
    expect(sql).toMatch(/pause_reason\s*=\s*NULL/i);
    expect(sql).toMatch(/needs_user_action\s*=\s*false/i);
    expect(sql).toMatch(/user_action_reason\s*=\s*NULL/i);
    expect(sql).toMatch(/WHERE/i);
    expect(sql).toMatch(/id\s*=\s*\$1/i);
    expect(sql).toMatch(/client_id\s*=\s*\$2/i);
    expect(sql).toMatch(/health_state\s*=\s*'paused'/i);
    expect(params).toEqual(['instance-1', 'client-1']);
  });

  it('never_writes_audit_outbox_or_wake_itself', async () => {
    const tx = fakeTx();
    const result = await humanResume(tx, {
      clientId: 'client-1',
      instanceId: 'instance-1',
      actor: USER_ACTOR,
    });

    // Exactly one statement - the whatsapp_instances write. No audit_logs,
    // outbox_events, or pg_notify call anywhere in this module.
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql] = tx.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/audit_logs/i);
    expect(sql).not.toMatch(/outbox_events/i);
    expect(sql).not.toMatch(/pg_notify/i);
    expect(result.resumed).toBe(true);
  });

  it('reports_resumed_false_when_the_instance_was_not_paused', async () => {
    const tx = fakeTx(0);
    const result = await humanResume(tx, {
      clientId: 'client-1',
      instanceId: 'instance-1',
      actor: USER_ACTOR,
    });
    expect(result.resumed).toBe(false);
  });
});
