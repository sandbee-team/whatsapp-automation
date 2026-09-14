import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { RETRY_CLASS_BY_CATEGORY } from '@wp/domain';
import { TransportSendError } from '../../provider/provider.types.js';
import { ClaimLostDuringSend } from './result.js';
import { bindQueueMetrics } from './metrics.js';
import { runOneSendLoopIteration, type SendLoopDeps } from './send-loop.js';

/**
 * send-loop.test.ts (P11 Unit U5, step 9) - unit test over the send loop's
 * pure orchestration surface (band selection -> claim -> dispatch ->
 * result), every collaborator injected/mocked - `claimOne`, `dispatch`,
 * `resolveAck`, `resolveFailure` are never the real Postgres-backed
 * implementations here (those are proved by U4's own integration suites and
 * `claim.*.integration.test.ts`). This file's own subject is: does the
 * loop call them in the right order, with the right inputs, under
 * concurrency 1, and wire `onClaimLost`/metrics correctly.
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const INSTANCE_ID = '22222222-2222-2222-2222-222222222222';

function makeClaimedJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'job-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    leaseId: 'lease-1',
    instanceId: INSTANCE_ID,
    sessionEpoch: 0,
    recipientJid: '15550000000@s.whatsapp.net',
    payload: { text: 'hi' },
    payloadKind: 'text',
    attempts: 0,
    campaignId: null,
    isNewConversation: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SendLoopDeps> = {}): SendLoopDeps {
  const registry = createMetricsRegistry();
  const metrics = bindQueueMetrics(registry);

  return {
    clientId: CLIENT_ID,
    instanceId: INSTANCE_ID,
    workerId: 'worker-1',
    fence: 1,
    claimOne: vi.fn().mockResolvedValue(undefined),
    dispatch: vi.fn(),
    resolveAck: vi.fn().mockResolvedValue(undefined),
    resolveFailure: vi.fn().mockResolvedValue(undefined),
    readMaxAttempts: vi.fn().mockResolvedValue(5),
    metrics,
    rng: { random: () => 0.5 },
    clock: { now: () => 0 },
    ...overrides,
  };
}

describe('runOneSendLoopIteration', () => {
  it('claims_the_high_band_first_and_dispatches_the_claimed_job', async () => {
    const job = makeClaimedJob();
    const claimOne = vi.fn().mockResolvedValueOnce(job);
    const dispatch = vi.fn().mockResolvedValueOnce({
      attemptNo: 1,
      outcome: 'settled',
      sendOutcome: { providerMsgId: 'wamid.1' },
    });

    const deps = makeDeps({ claimOne, dispatch });
    const result = await runOneSendLoopIteration(deps);

    expect(claimOne.mock.calls[0]![1]).toMatchObject({
      instanceId: INSTANCE_ID,
      band: 6, // HIGH weight, DEFAULT_BAND_WEIGHTS.HIGH
      fence: 1,
      workerId: 'worker-1',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(deps.resolveAck).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ claimed: true });
  });

  it('falls_through_high_then_normal_then_low_when_each_band_is_empty', async () => {
    const job = makeClaimedJob();
    const claimOne = vi
      .fn()
      .mockResolvedValueOnce(undefined) // HIGH (6) empty
      .mockResolvedValueOnce(undefined) // NORMAL (3) empty
      .mockResolvedValueOnce(job); // LOW (1) has a job
    const dispatch = vi.fn().mockResolvedValueOnce({
      attemptNo: 1,
      outcome: 'settled',
      sendOutcome: { providerMsgId: 'wamid.1' },
    });

    const deps = makeDeps({ claimOne, dispatch });
    const result = await runOneSendLoopIteration(deps);

    expect(claimOne).toHaveBeenCalledTimes(3);
    expect(claimOne.mock.calls[0]![1]).toMatchObject({ band: 6 });
    expect(claimOne.mock.calls[1]![1]).toMatchObject({ band: 3 });
    expect(claimOne.mock.calls[2]![1]).toMatchObject({ band: 1 });
    expect(result).toEqual({ claimed: true });
  });

  it('every_band_empty_resolves_to_not_claimed_without_calling_dispatch', async () => {
    const claimOne = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn();

    const deps = makeDeps({ claimOne, dispatch });
    const result = await runOneSendLoopIteration(deps);

    expect(claimOne).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: false });
  });

  it('a_settled_send_with_a_provider_error_routes_through_resolveFailure', async () => {
    const job = makeClaimedJob();
    const claimOne = vi.fn().mockResolvedValueOnce(job);
    const sendError = new TransportSendError('transient', 'temporary blip');
    const dispatch = vi.fn().mockResolvedValueOnce({ attemptNo: 1, outcome: 'settled', sendError });

    const deps = makeDeps({ claimOne, dispatch });
    await runOneSendLoopIteration(deps);

    expect(deps.resolveAck).not.toHaveBeenCalled();
    expect(deps.resolveFailure).toHaveBeenCalledTimes(1);
    const failureInput = (deps.resolveFailure as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(failureInput.error).toBe(sendError);
  });

  it('a_timed_out_send_routes_through_resolveFailure_as_UNKNOWN_never_transient', async () => {
    // 2026-09-14: this test previously asserted `'transient'`, which pinned a
    // real defect rather than a contract. `transient` maps to RETRY_BACKOFF,
    // so a timed-out send was requeued and sent AGAIN - but a timeout means
    // the provider never answered, not that nothing was delivered. Retrying
    // is a guaranteed double-send and breaks core invariant 2 (fail-safe).
    // `dispatch.ts`'s own header states it: "A send timeout is
    // `dispatched`/unknown, never a retry decision made HERE."
    const job = makeClaimedJob();
    const claimOne = vi.fn().mockResolvedValueOnce(job);
    const dispatch = vi.fn().mockResolvedValueOnce({ attemptNo: 1, outcome: 'timed_out' });

    const deps = makeDeps({ claimOne, dispatch });
    await runOneSendLoopIteration(deps);

    expect(deps.resolveFailure).toHaveBeenCalledTimes(1);
    const failureInput = (deps.resolveFailure as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(failureInput.error).toBeInstanceOf(TransportSendError);
    expect(failureInput.error.class).toBe('unknown');
  });

  it('the_timeout_category_resolves_to_PAUSE_INSTANCE_not_a_retry', async () => {
    // The half that actually protects the recipient: it is not enough for the
    // send loop to LABEL a timeout `unknown` - that category must still carry
    // a non-retrying class all the way through the domain table. `unknown` is
    // documented there as non-overridable precisely so no injected table can
    // downgrade it back to a retry.
    expect(RETRY_CLASS_BY_CATEGORY.unknown).toBe('PAUSE_INSTANCE');
    expect(RETRY_CLASS_BY_CATEGORY.transient).toBe('RETRY_BACKOFF');
  });

  it('a_claim_lost_during_result_write_increments_wp_claim_lost_total_via_the_injected_port', async () => {
    const job = makeClaimedJob();
    const claimOne = vi.fn().mockResolvedValueOnce(job);
    const dispatch = vi.fn().mockResolvedValueOnce({
      attemptNo: 1,
      outcome: 'settled',
      sendOutcome: { providerMsgId: 'wamid.1' },
    });

    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);
    const incSpy = vi.spyOn(metrics.claimLostTotal, 'inc');

    const resolveAck = vi.fn().mockImplementation(async (_input, resultDeps) => {
      resultDeps.onClaimLost?.();
      throw new ClaimLostDuringSend(job.id);
    });

    const deps = makeDeps({ claimOne, dispatch, resolveAck, metrics });

    // The loop must not let a lost-claim during result-write escape as an
    // unhandled rejection - it is a NORMAL outcome (another worker owns the
    // job now), not a loop failure.
    await expect(runOneSendLoopIteration(deps)).resolves.toEqual({ claimed: true });
    expect(incSpy).toHaveBeenCalledTimes(1);
  });

  // P13: the pacing reserve now lives INSIDE deps.claimOne itself (see
  // send-loop.ts's own module doc, "PACING (P13)") - a pacing denial and an
  // empty band are indistinguishable at THIS loop's level, both resolving
  // to `undefined`, so `every_band_empty_resolves_to_not_claimed_without_
  // calling_dispatch` above already covers a pacing-denied instance's
  // shape too (three `undefined` claimOne calls falling through to
  // `{ claimed: false }`) - no separate test needed for that case.
});
