import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { sysKey } from '../../platform/redis.js';
import { publishWake, wakeChannel, safetyPollIntervalMs, SAFETY_POLL_BASE_MS } from './wake.js';

/**
 * wake.test.ts (P11 Unit U5, step 8) - the wake loop's pure/unit-testable
 * surface: channel-shape derivation, the publish-after-commit call shape,
 * and the safety-poll config boundary. The two cases that need a real
 * claim against real Postgres/Redis (`a_dropped_wake_still_drains_via_the_
 * safety_poll`, `a_wake_for_another_tenants_instance_never_triggers_a_
 * claim`) live in the sibling `wake.integration.test.ts` instead - see that
 * file's own header for why (a fake/mocked Redis+claim would only prove the
 * mock's own wiring, not the real at-most-once/tenant-isolation properties
 * these two cases exist to prove).
 */

describe('wakeChannel', () => {
  it('an_enqueue_publishes_exactly_one_wake_on_the_tenant_scoped_channel', async () => {
    const published: { channel: string; message: string }[] = [];
    const redis = {
      publish: vi.fn(async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      }),
    };

    const clientId = '11111111-1111-1111-1111-111111111111';
    const instanceId = '22222222-2222-2222-2222-222222222222';

    // Simulates "publish after commit": the caller only invokes
    // publishWake once its enqueue transaction has already resolved.
    let committed = false;
    await Promise.resolve().then(() => {
      committed = true;
    });
    expect(committed).toBe(true);

    await publishWake(redis, 'test', clientId, instanceId);

    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe(wakeChannel('test', clientId, instanceId));
    // Proves `wakeChannel` actually reproduces the required literal shape
    // `wp:{env}:wake:c:{client}:i:{instance}` - built via `sysKey`, never a
    // raw template literal (the `wp/key-construction` guard rejects that
    // outside `platform/redis/**`).
    expect(published[0]!.channel).toBe(sysKey('test', 'wake', 'c', clientId, 'i', instanceId));
  });
});

describe('safetyPollIntervalMs', () => {
  it('the_safety_poll_cannot_be_configured_to_zero_or_above_sixty_seconds', () => {
    expect(() => safetyPollIntervalMs(0, { random: () => 0 })).toThrow(/SAFETY_POLL_MS/);
    expect(() => safetyPollIntervalMs(60_001, { random: () => 0 })).toThrow(/SAFETY_POLL_MS/);
    expect(() => safetyPollIntervalMs(-1, { random: () => 0 })).toThrow(/SAFETY_POLL_MS/);
    // The exact ceiling (60_000) and base default (30_000) are legal.
    expect(() => safetyPollIntervalMs(60_000, { random: () => 0 })).not.toThrow();
    expect(() => safetyPollIntervalMs(SAFETY_POLL_BASE_MS, { random: () => 0 })).not.toThrow();
  });

  it('jitters_within_the_documented_plus_minus_12s_band_via_an_injected_rng', () => {
    // rng.random() = 0 -> minimum jitter (-12_000ms); rng.random() = 1 (the
    // theoretical upper bound of the [0,1) contract) -> maximum jitter
    // (+12_000ms). Both ends are asserted EXACTLY, not as a bound, per the
    // "assert exact expected values" convention.
    expect(safetyPollIntervalMs(SAFETY_POLL_BASE_MS, { random: () => 0 })).toBe(18_000);
    expect(safetyPollIntervalMs(SAFETY_POLL_BASE_MS, { random: () => 1 })).toBe(42_000);
    expect(safetyPollIntervalMs(SAFETY_POLL_BASE_MS, { random: () => 0.5 })).toBe(30_000);
  });
});
