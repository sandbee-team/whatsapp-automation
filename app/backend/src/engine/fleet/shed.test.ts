import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { chooseShedVictims, type ShedCandidate } from './shed.js';

/**
 * shed.test.ts (P09 U4 step 6) - `chooseShedVictims`'s pure victim-selection
 * logic: exclusion (in-flight send OR pairing in progress) is checked BEFORE
 * any ordering, then the remaining candidates are ordered most-recently-
 * acquired first, tie-broken by idle (no in-flight AND no conversation
 * activity within 60s beats active), then smallest `queueDepth`.
 */

function makeCandidate(overrides: Partial<ShedCandidate> = {}): ShedCandidate {
  return {
    instanceId: 'inst-default',
    clientId: 'client-default',
    acquiredAtMonotonic: 0,
    inFlightSendCount: 0,
    lastConversationActivityAtMonotonic: null,
    queueDepth: 0,
    pairingInProgress: false,
    ...overrides,
  };
}

describe('chooseShedVictims', () => {
  it('shed_never_selects_an_inflight_send_or_a_pairing_instance', () => {
    const inFlight = makeCandidate({
      instanceId: 'inst-inflight',
      inFlightSendCount: 1,
      acquiredAtMonotonic: 1000, // most recent - would otherwise win
    });
    const pairing = makeCandidate({
      instanceId: 'inst-pairing',
      pairingInProgress: true,
      acquiredAtMonotonic: 900, // second most recent - would otherwise win
    });
    const eligible = makeCandidate({
      instanceId: 'inst-eligible',
      acquiredAtMonotonic: 500,
    });

    const victims = chooseShedVictims([inFlight, pairing, eligible], 3);

    expect(victims).toEqual(['inst-eligible']);
  });

  it('shed_victim_order_is_most_recent_idle_smallest_queue', () => {
    const now = 60_000;
    // A: most recently acquired, active (beats everything on recency alone).
    const a = makeCandidate({
      instanceId: 'inst-a',
      acquiredAtMonotonic: 5000,
      lastConversationActivityAtMonotonic: now - 1000, // active (< 60s ago)
      queueDepth: 10,
    });
    // B and C tie on acquiredAtMonotonic; B is idle, C is active - B wins the tie.
    const b = makeCandidate({
      instanceId: 'inst-b',
      acquiredAtMonotonic: 4000,
      lastConversationActivityAtMonotonic: null, // idle
      queueDepth: 5,
    });
    const c = makeCandidate({
      instanceId: 'inst-c',
      acquiredAtMonotonic: 4000,
      lastConversationActivityAtMonotonic: now - 1000, // active
      queueDepth: 1,
    });
    // D and E tie on acquiredAtMonotonic AND idle-ness; D has a smaller queue depth.
    const d = makeCandidate({
      instanceId: 'inst-d',
      acquiredAtMonotonic: 3000,
      lastConversationActivityAtMonotonic: now - 120_000, // idle (>= 60s ago)
      queueDepth: 2,
    });
    const e = makeCandidate({
      instanceId: 'inst-e',
      acquiredAtMonotonic: 3000,
      lastConversationActivityAtMonotonic: now - 120_000, // idle
      queueDepth: 20,
    });

    const victims = chooseShedVictims([e, c, a, d, b], 5, now);

    expect(victims).toEqual(['inst-a', 'inst-b', 'inst-c', 'inst-d', 'inst-e']);
  });

  it('deterministic_stable_sort_over_a_larger_fixture_set', () => {
    const now = 100_000;
    const candidates: ShedCandidate[] = [
      makeCandidate({ instanceId: 'x1', acquiredAtMonotonic: 10, queueDepth: 3 }),
      makeCandidate({ instanceId: 'x2', acquiredAtMonotonic: 10, queueDepth: 3 }),
      makeCandidate({ instanceId: 'x3', acquiredAtMonotonic: 10, queueDepth: 3 }),
    ];

    const first = chooseShedVictims(candidates, 3, now);
    const second = chooseShedVictims(candidates, 3, now);

    // Identical, fully-tied candidates keep their original relative order
    // (stable sort) and produce the exact same result every time.
    expect(first).toEqual(['x1', 'x2', 'x3']);
    expect(second).toEqual(first);
  });

  it('respects_the_requested_n_limit', () => {
    const candidates: ShedCandidate[] = [
      makeCandidate({ instanceId: 'y1', acquiredAtMonotonic: 3 }),
      makeCandidate({ instanceId: 'y2', acquiredAtMonotonic: 2 }),
      makeCandidate({ instanceId: 'y3', acquiredAtMonotonic: 1 }),
    ];

    const victims = chooseShedVictims(candidates, 2);

    expect(victims).toEqual(['y1', 'y2']);
  });
});

describe('shedVictims', () => {
  it('executes_end_socket_then_release_lease_per_victim_and_errors_on_one_do_not_abort_the_rest', async () => {
    const { shedVictims } = await import('./shed.js');
    const calls: string[] = [];
    const endSocket = vi.fn(async (instanceId: string) => {
      calls.push(`end:${instanceId}`);
      if (instanceId === 'inst-fails') {
        throw new Error('boom');
      }
    });
    const releaseLeaseGracefully = vi.fn(async (instanceId: string) => {
      calls.push(`release:${instanceId}`);
    });

    const results = await shedVictims(['inst-fails', 'inst-ok'], {
      endSocket,
      releaseLeaseGracefully,
    });

    // Both victims attempted, in order - INCLUDING releaseLeaseGracefully
    // for the victim whose endSocket threw (WARNING FIX 4: a failed end
    // must still attempt a graceful release, never skip it).
    expect(calls).toEqual([
      'end:inst-fails',
      'release:inst-fails',
      'end:inst-ok',
      'release:inst-ok',
    ]);
    expect(results).toEqual([
      {
        instanceId: 'inst-fails',
        ok: false,
        endOk: false,
        releaseOk: true,
        error: expect.any(Error),
      },
      { instanceId: 'inst-ok', ok: true, endOk: true, releaseOk: true },
    ]);
  });

  it('WARNING FIX 4: a throwing endSocket still attempts releaseLeaseGracefully (both outcomes recorded independently)', async () => {
    const { shedVictims } = await import('./shed.js');
    const releaseLeaseGracefully = vi.fn(async () => undefined);
    const endSocket = vi.fn(async () => {
      throw new Error('end failed');
    });

    const results = await shedVictims(['inst-1'], { endSocket, releaseLeaseGracefully });

    expect(releaseLeaseGracefully).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { instanceId: 'inst-1', ok: false, endOk: false, releaseOk: true, error: expect.any(Error) },
    ]);
  });
});
