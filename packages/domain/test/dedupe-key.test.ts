import { describe, expect, it } from 'vitest';
import { notificationDedupeKeyInput } from '../src/notifications/dedupe-key.js';

/**
 * dedupe-key.test.ts (P17 Unit U2) - property-style proof over generated
 * uuid-shaped ids: same inputs produce the identical canonicalised key
 * input; two different instanceIds (same kind+transitionId) differ; two
 * different transitionIds differ. See dedupe-key.ts's own header for why
 * this module exports the pure canonicalisation string rather than a
 * `sha256(...)` wrapper (packages/domain must stay Node-builtin-free -
 * `.dependency-cruiser.cjs`'s `domain-must-be-pure-core` rule forbids
 * `node:crypto` from `packages/domain/src/**`, same split as
 * `content-hash.ts`/`delivery-event-id.ts`).
 */

function fakeUuid(seed: string): string {
  // Not a real UUID generator - just a deterministic, distinct 36-char
  // uuid-SHAPED string per seed, which is all this test needs.
  const padded = seed.padStart(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${padded}`;
}

describe('notificationDedupeKeyInput (P17 Unit U2)', () => {
  it('the_key_is_stable_per_transition_and_differs_across_instances', () => {
    const instanceA = fakeUuid('a1');
    const instanceB = fakeUuid('b2');
    const transitionX = fakeUuid('x1');
    const transitionY = fakeUuid('y2');

    // Same inputs -> identical key, run repeatedly.
    const keyOnce = notificationDedupeKeyInput({
      kind: 'instance_paused',
      instanceId: instanceA,
      transitionId: transitionX,
    });
    const keyAgain = notificationDedupeKeyInput({
      kind: 'instance_paused',
      instanceId: instanceA,
      transitionId: transitionX,
    });
    expect(keyAgain).toBe(keyOnce);

    // Different instanceId, same kind+transitionId -> different key.
    const keyOtherInstance = notificationDedupeKeyInput({
      kind: 'instance_paused',
      instanceId: instanceB,
      transitionId: transitionX,
    });
    expect(keyOtherInstance).not.toBe(keyOnce);

    // Different transitionId, same kind+instanceId -> different key.
    const keyOtherTransition = notificationDedupeKeyInput({
      kind: 'instance_paused',
      instanceId: instanceA,
      transitionId: transitionY,
    });
    expect(keyOtherTransition).not.toBe(keyOnce);

    // instanceId optional -> empty segment, still stable/repeatable.
    const noInstanceOnce = notificationDedupeKeyInput({
      kind: 'plan_cap_reached',
      transitionId: transitionX,
      bucket: '2026-09-03',
    });
    const noInstanceAgain = notificationDedupeKeyInput({
      kind: 'plan_cap_reached',
      transitionId: transitionX,
      bucket: '2026-09-03',
    });
    expect(noInstanceAgain).toBe(noInstanceOnce);
    expect(noInstanceOnce).not.toBe(keyOnce);

    // bucket differs -> different key (instance-day dedupe scope).
    const otherBucket = notificationDedupeKeyInput({
      kind: 'plan_cap_reached',
      transitionId: transitionX,
      bucket: '2026-09-04',
    });
    expect(otherBucket).not.toBe(noInstanceOnce);
  });
});
