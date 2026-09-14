import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS } from '../src/enums/index.js';
import { NOTIFICATION_KIND_REGISTRY } from '../src/notifications/kinds.js';

/**
 * notification-kinds.test.ts (P17 Unit U2) - proves the kind registry is
 * total over `NOTIFICATION_KINDS`, that the six blueprint-mandatory kinds
 * are exactly `mandatory: true` with the full three-channel fanout and no
 * suppression path, and that every kind (mandatory or not) always includes
 * the `sse` channel (the in-app row + bell hint always exist).
 */

const MANDATORY_KINDS = [
  'instance_paused',
  'instance_logged_out',
  'reconnect_budget_exhausted',
  'duplicate_fanout_ack_required',
  'unresolved_send',
  'plan_cap_reached',
] as const;

describe('NOTIFICATION_KIND_REGISTRY (P17 Unit U2)', () => {
  it('every_mandatory_blueprint_kind_is_registered_and_not_suppressible', () => {
    for (const kind of MANDATORY_KINDS) {
      const entry = NOTIFICATION_KIND_REGISTRY[kind];
      expect(entry.mandatory).toBe(true);
      expect(entry.channels).toEqual(['sse', 'email', 'webhook']);
    }

    // Total over NOTIFICATION_KINDS - every declared kind has a registry
    // entry, no silent gap.
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind]).toBeDefined();
    }
    expect(Object.keys(NOTIFICATION_KIND_REGISTRY).sort()).toEqual([...NOTIFICATION_KINDS].sort());

    // Every registry entry includes 'sse' - the in-app row + bell hint
    // always exist, mandatory or not.
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind].channels).toContain('sse');
    }

    // The two non-mandatory registered kinds, exact shape per the binding
    // facts (not derived from the mandatory set above).
    expect(NOTIFICATION_KIND_REGISTRY.infra_unavailable).toEqual({
      severity: 'critical',
      channels: ['sse', 'email', 'webhook'],
      mandatory: false,
      dedupeScope: 'transition',
    });
    expect(NOTIFICATION_KIND_REGISTRY.warmup_tier_changed).toEqual({
      severity: 'info',
      channels: ['sse'],
      mandatory: false,
      dedupeScope: 'transition',
    });

    // Severities for the six mandatory kinds, exact per the binding facts.
    expect(NOTIFICATION_KIND_REGISTRY.instance_paused.severity).toBe('critical');
    expect(NOTIFICATION_KIND_REGISTRY.instance_logged_out.severity).toBe('critical');
    expect(NOTIFICATION_KIND_REGISTRY.reconnect_budget_exhausted.severity).toBe('critical');
    expect(NOTIFICATION_KIND_REGISTRY.duplicate_fanout_ack_required.severity).toBe('warning');
    expect(NOTIFICATION_KIND_REGISTRY.unresolved_send.severity).toBe('warning');
    expect(NOTIFICATION_KIND_REGISTRY.plan_cap_reached.severity).toBe('warning');

    // dedupeScope: 'instance-day' is exactly {plan_cap_reached, wallet_low}
    // (P19 Unit U4 adds the second - a genuinely repeating daily condition,
    // same as plan_cap_reached) - everything else is 'transition'.
    // P25 U3: `optout_rate_high` is the third 'instance-day' kind (one tenant
    // notification per client per UTC day - see kinds.ts).
    const INSTANCE_DAY_KINDS = ['plan_cap_reached', 'wallet_low', 'optout_rate_high'] as const;
    for (const kind of INSTANCE_DAY_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind].dedupeScope).toBe('instance-day');
    }
    for (const kind of NOTIFICATION_KINDS) {
      if ((INSTANCE_DAY_KINDS as readonly string[]).includes(kind)) continue;
      expect(NOTIFICATION_KIND_REGISTRY[kind].dedupeScope).toBe('transition');
    }

    // The two P19 Unit U4 wallet kinds, exact shape per the binding facts.
    expect(NOTIFICATION_KIND_REGISTRY.wallet_low).toEqual({
      severity: 'warning',
      channels: ['sse', 'email', 'webhook'],
      mandatory: false,
      dedupeScope: 'instance-day',
    });
    expect(NOTIFICATION_KIND_REGISTRY.wallet_empty).toEqual({
      severity: 'critical',
      channels: ['sse', 'email', 'webhook'],
      mandatory: false,
      dedupeScope: 'transition',
    });

    // P24 (groups-messaging) Unit U1 - the group_forbidden kind, exact shape
    // per the binding facts.
    expect(NOTIFICATION_KIND_REGISTRY.group_forbidden).toEqual({
      severity: 'warning',
      channels: ['sse', 'email', 'webhook'],
      mandatory: false,
      dedupeScope: 'transition',
    });

    // No exported function/flag removes a channel from a mandatory kind -
    // the registry object is deeply frozen (top level and every entry).
    expect(Object.isFrozen(NOTIFICATION_KIND_REGISTRY)).toBe(true);
    for (const kind of NOTIFICATION_KINDS) {
      const entry = NOTIFICATION_KIND_REGISTRY[kind];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.channels)).toBe(true);
    }
  });
});
