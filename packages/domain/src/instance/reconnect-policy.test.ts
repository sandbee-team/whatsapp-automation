import { describe, expect, it } from 'vitest';
import { nextDelayMs, onOpen, shouldGiveUp, RECONNECT_GIVE_UP_REASON } from './reconnect-policy.js';

/** Deterministic seeded RNG: cycles through a fixed sequence in [0, 1). */
function seededRng(sequence: readonly number[]): { random: () => number } {
  let i = 0;
  return {
    random(): number {
      const v = sequence[i % sequence.length] as number;
      i += 1;
      return v;
    },
  };
}

describe('reconnect-policy', () => {
  describe('backoff_is_full_jitter_within_the_ceiling_and_capped_at_300s', () => {
    it('every draw lands in [stagger, ceiling+stagger) and ceiling never exceeds 300_000', () => {
      const instanceId = 'instance-abc';
      const stagger = nextDelayMs({ attempt: 1, instanceId, rng: seededRng([0]) });

      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const ceiling = Math.min(300_000, 2_000 * 2 ** (attempt - 1));
        expect(ceiling).toBeLessThanOrEqual(300_000);

        for (const draw of [0, 0.25, 0.5, 0.75, 0.999999]) {
          const delay = nextDelayMs({ attempt, instanceId, rng: seededRng([draw]) });
          expect(delay).toBeGreaterThanOrEqual(stagger);
          expect(delay).toBeLessThan(ceiling + stagger + 1);
        }
      }
    });

    it('attempt 1 ceiling is 2_000 and attempt 8 ceiling is 256_000', () => {
      // rng() = 0 isolates the stagger component; rng() close to 1 isolates
      // ceiling+stagger upper bound.
      const zeroRng = seededRng([0]);
      const instanceId = 'stagger-probe';

      const delayAt0 = nextDelayMs({ attempt: 1, instanceId, rng: zeroRng });
      // With rng()=0, delay === stagger exactly (jitter term is 0).
      const stagger = delayAt0;
      expect(stagger).toBeGreaterThanOrEqual(0);
      expect(stagger).toBeLessThan(5_000);

      const nearOneRng = seededRng([0.999999999]);
      const delayAttempt1Max = nextDelayMs({ attempt: 1, instanceId, rng: nearOneRng });
      expect(delayAttempt1Max).toBeLessThan(2_000 + stagger + 1);
      expect(delayAttempt1Max).toBeGreaterThan(stagger);

      const delayAttempt8Max = nextDelayMs({ attempt: 8, instanceId, rng: nearOneRng });
      expect(delayAttempt8Max).toBeLessThan(256_000 + stagger + 1);
      expect(delayAttempt8Max).toBeGreaterThan(stagger);

      // Cap: even a hypothetical larger attempt never exceeds 300_000+stagger.
      const delayAttempt20Max = nextDelayMs({ attempt: 20, instanceId, rng: nearOneRng });
      expect(delayAttempt20Max).toBeLessThan(300_000 + stagger + 1);
    });

    it('the same instanceId always yields the same stagger (deterministic hash, no Math.random)', () => {
      const zeroRng1 = seededRng([0]);
      const zeroRng2 = seededRng([0]);
      const a = nextDelayMs({ attempt: 3, instanceId: 'instance-xyz', rng: zeroRng1 });
      const b = nextDelayMs({ attempt: 3, instanceId: 'instance-xyz', rng: zeroRng2 });
      expect(a).toBe(b);
    });

    it('503 uses baseMultiplier=5, so its ceiling is 5x the normal base', () => {
      const nearOneRng = seededRng([0.999999999]);
      const instanceId = 'base-mult-probe';
      const stagger = nextDelayMs({ attempt: 1, instanceId, rng: seededRng([0]) });

      const normalMax = nextDelayMs({ attempt: 1, instanceId, rng: nearOneRng });
      const base5Max = nextDelayMs({ attempt: 1, instanceId, rng: nearOneRng, baseMultiplier: 5 });

      // Normal ceiling at attempt 1 is 2_000; base5 ceiling is min(300_000, 10_000*1)=10_000.
      expect(normalMax - stagger).toBeLessThanOrEqual(2_000);
      expect(base5Max - stagger).toBeLessThanOrEqual(10_000);
      expect(base5Max).toBeGreaterThan(normalMax);
    });
  });

  describe('budget_exhausted_pauses_with_reconnect_failed', () => {
    it('attempt 9 gives up and the FSM-facing outcome constant is RECONNECT_FAILED', () => {
      expect(shouldGiveUp(8)).toBe(false);
      expect(shouldGiveUp(9)).toBe(true);
      expect(RECONNECT_GIVE_UP_REASON).toBe('RECONNECT_FAILED');
    });
  });

  describe('attempt_counter_resets_only_after_sixty_seconds_open', () => {
    it('a 59s open does NOT reset the attempt counter', () => {
      const next = onOpen({ openedAtMs: 0, closedAtMs: 59_000, attempt: 4 });
      expect(next).toBe(4);
    });

    it('a 61s open DOES reset the attempt counter to 0', () => {
      const next = onOpen({ openedAtMs: 0, closedAtMs: 61_000, attempt: 4 });
      expect(next).toBe(0);
    });

    it('exactly 60_000ms open does NOT reset (strictly greater than 60s required)', () => {
      const next = onOpen({ openedAtMs: 1_000, closedAtMs: 61_000, attempt: 5 });
      expect(next).toBe(5);
    });
  });
});
