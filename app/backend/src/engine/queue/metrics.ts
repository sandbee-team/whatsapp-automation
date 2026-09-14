import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * engine/queue/metrics.ts (P11 Unit U5, step 9) - the seven send-loop
 * metrics. NONE of them carries `instance_id`/`client_id` - the four-gauge
 * `INSTANCE_LABELLED_GAUGES` allow-list (`@wp/server-kit`'s
 * `metric-policy.ts`) is already spent by P09's dashboard gauges, and a
 * fifth instance-labelled metric THROWS at registration (phase gotcha,
 * verbatim). `wp_queue_depth_total` and `wp_oldest_queued_seconds_max`
 * therefore AGGREGATE across every instance rather than carrying a label -
 * per-instance queue depth/lag is served to the panel from PostgreSQL
 * rollups instead (delta, "Observability: one rule, not two").
 *
 *   - `wp_claim_lost_total` (counter, no label) - `result.ts`'s
 *     `ResultDeps.onClaimLost` port fires this exactly once, synchronously,
 *     immediately before `resolveAck`/`resolveFailure` throw
 *     `ClaimLostDuringSend` (another worker owns the job now).
 *   - `wp_send_attempts_total{result}` (counter) - one increment per
 *     dispatch outcome; `result` is one of `send-loop.ts`'s own outcome
 *     labels (`sent`, `failed`, `timed_out`, `claim_lost`) - `result` is
 *     already on `ALLOWED_LABELS`.
 *   - `wp_send_duration_seconds` (histogram, no label) - wall time from
 *     `dispatch()` starting to `result()` resolving, per attempt.
 *   - `wp_wake_received_total` (counter, no label) - incremented by
 *     `wake.ts`'s subscriber on every message actually received on this
 *     instance's own wake channel.
 *   - `wp_safety_poll_claims_total` (counter, no label) - incremented by
 *     `send-loop.ts` when a claim attempt was triggered by the mandatory
 *     safety-poll timer rather than a wake or the per-instance
 *     `next_eligible_at` timer - the metric that proves the poll is
 *     actually doing correctness work (a dropped wake still drains).
 *   - `wp_queue_depth_total` (gauge, no label) - fleet-wide queued job
 *     count, refreshed on a cadence outside this module's own concern.
 *   - `wp_oldest_queued_seconds_max` (gauge, no label) - fleet-wide oldest
 *     queued-job age, in seconds.
 *   - `wp_reconcile_ambiguous_total` (counter, no label; P12 Unit U3) - one
 *     of canon's three "honesty metrics" (ADR 0035 §6/consequences): the
 *     echo reconciler increments this whenever >1 in-flight attempt shares a
 *     content hash and resolves NONE of them (both to `blocked_needs_
 *     review`). A sustained non-zero rate is the signal that the
 *     `client_msg_id` correlation upgrade (ADR 0035's named P13+ follow-up)
 *     should be pulled forward.
 *   - `wp_echo_capture_failed_total` (counter, no label; P12 Unit U3) -
 *     incremented once per `fromMe` echo `echo-capture.ts` could not record
 *     (missing id/content/jid, or a DB error) - a throw skips one echo,
 *     never the socket; this is the counted signal that replaces the
 *     `inbound_dead_letters` table P21's inbox owns.
 *   - `wp_reaper_repairs_total{result}` (counter; P12 Unit U2, step 3) - one
 *     increment per `wp_reap_expired_leases` RETURNING row, labelled with the
 *     closed `ReapOutcome` union (`modules/queue/reaper.ts`'s `REAP_OUTCOMES`)
 *     - `requeued_no_attempt`, `requeued_prepared`, `requeued_failed`,
 *     `needs_reconcile`, `repaired_sent`. Uses the `result` label name (not
 *     `outcome` - `outcome` is not in `@wp/server-kit`'s `ALLOWED_LABELS` and
 *     adding a new label name requires an ADR; `result` is already allowed
 *     and already used for the same small-outcome-union shape by
 *     `sendAttemptsTotal` above).
 *   - `wp_unresolved_jobs_total` (counter, no label; P12 Unit U2) -
 *     incremented once per job the reaper moves to `needs_reconcile`
 *     (contract row 3) - the honesty metric that a crashed-mid-dispatch send
 *     is pending human/reconciler resolution, never silently unclaimable.
 *   - `wp_content_guard_trips_total{reason}` (counter; P14 Unit U6) - one
 *     increment per content-guard trip (`modules/pacing/guards/pipeline.ts#
 *     evaluateGuards` denial), terminal OR deferred alike, labelled by the
 *     exact `DenyReason` string. No `client_id`/`instance_id` label (the
 *     four-gauge instance-labelled allow-list is already spent - see this
 *     module's own header).
 *   - `wp_optout_cancelled_jobs_total` (counter, no label; P14 Unit U6) -
 *     incremented once per job the guard pipeline disposes with `OPT_OUT`
 *     specifically (a strict subset of `wp_content_guard_trips_total
 *     {reason="OPT_OUT"}` - kept as its own counter because "how many sends
 *     did we skip for an opted-out contact" is a distinct product/safety
 *     signal worth its own name, not something a caller should have to
 *     filter a labelled counter to recover).
 *   - `wp_send_loop_iteration_errors_total{reason}` (counter; P14 fix round
 *     F3 finding 1) - incremented once per `send-loop-fleet-wiring.ts#
 *     trigger` iteration whose `runOneIteration` call rejected, `reason`
 *     bound to the rejecting error's `name` (e.g.
 *     `GuardPipelineStateInvalidError` - a config-integrity fault, given its
 *     own reason so it can alert distinctly). No `client_id`/`instance_id`
 *     label (allow-list already spent, same as `wp_content_guard_trips_
 *     total`) - per-instance detail is in the structured log line the same
 *     catch writes, ids only.
 *   - `wp_send_errors_total{error_class}` (counter; P25 U1b gap-fill) -
 *     blueprint's `wp_send_total{result,error_class}` half not yet covered
 *     by `sendAttemptsTotal{result}` above: "error-class mix is the earliest
 *     legitimate ban-risk signal". Incremented (alongside `sendAttemptsTotal
 *     {result}`) by `recordSendFailure` in the sibling `send-failure-
 *     metrics.ts` - moved out of THIS file because its `TransportSendError`
 *     parameter type would otherwise put a `provider/**` import on a module
 *     `cron-wiring.ts` reaches directly (`bindQueueMetrics`, P11 Unit U5) -
 *     the cron process owns no socket/provider connection, see
 *     `cron-loop-shape.test.ts`.
 *
 * Same idempotent-registration `WeakMap` pattern as
 * `engine/fleet/metrics.ts` / `platform/metrics/lease-metrics.ts`.
 */

export interface QueueMetricsHandles {
  claimLostTotal: ReturnType<MetricsRegistry['counter']>;
  sendAttemptsTotal: ReturnType<MetricsRegistry['counter']>;
  sendDurationSeconds: ReturnType<MetricsRegistry['histogram']>;
  wakeReceivedTotal: ReturnType<MetricsRegistry['counter']>;
  safetyPollClaimsTotal: ReturnType<MetricsRegistry['counter']>;
  queueDepthTotal: ReturnType<MetricsRegistry['gauge']>;
  oldestQueuedSecondsMax: ReturnType<MetricsRegistry['gauge']>;
  reconcileAmbiguousTotal: ReturnType<MetricsRegistry['counter']>;
  echoCaptureFailedTotal: ReturnType<MetricsRegistry['counter']>;
  reaperRepairsTotal: ReturnType<MetricsRegistry['counter']>;
  unresolvedJobsTotal: ReturnType<MetricsRegistry['counter']>;
  contentGuardTripsTotal: ReturnType<MetricsRegistry['counter']>;
  optoutCancelledJobsTotal: ReturnType<MetricsRegistry['counter']>;
  sendLoopIterationErrorsTotal: ReturnType<MetricsRegistry['counter']>;
  sendErrorsTotal: ReturnType<MetricsRegistry['counter']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, QueueMetricsHandles>();

export function bindQueueMetrics(registry: MetricsRegistry = defaultMetrics): QueueMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: QueueMetricsHandles = {
    claimLostTotal: registry.counter(
      'wp_claim_lost_total',
      'Job outcome writes that found zero matching rows - another worker owned the job by then',
    ),
    sendAttemptsTotal: registry.counter('wp_send_attempts_total', 'Send attempts by outcome', [
      'result',
    ]),
    sendDurationSeconds: registry.histogram(
      'wp_send_duration_seconds',
      'Wall time from dispatch start to result resolution, per attempt, in seconds',
    ),
    wakeReceivedTotal: registry.counter(
      'wp_wake_received_total',
      'Wake pub/sub messages actually received on a subscribed instance channel',
    ),
    safetyPollClaimsTotal: registry.counter(
      'wp_safety_poll_claims_total',
      'Claim attempts triggered by the mandatory safety-poll timer rather than a wake or the per-instance eligibility timer',
    ),
    queueDepthTotal: registry.gauge(
      'wp_queue_depth_total',
      'Fleet-wide queued message_jobs count (aggregate, no instance_id label)',
    ),
    oldestQueuedSecondsMax: registry.gauge(
      'wp_oldest_queued_seconds_max',
      'Fleet-wide oldest queued job age in seconds (aggregate, no instance_id label)',
    ),
    reconcileAmbiguousTotal: registry.counter(
      'wp_reconcile_ambiguous_total',
      'Echo reconciler runs where >1 in-flight attempt shared a content hash and none was resolved',
    ),
    echoCaptureFailedTotal: registry.counter(
      'wp_echo_capture_failed_total',
      'fromMe echoes that could not be recorded (missing id/content/jid, or a DB error)',
    ),
    reaperRepairsTotal: registry.counter(
      'wp_reaper_repairs_total',
      'Lease-expiry repairs made by the reaper, by outcome (label name: result)',
      ['result'],
    ),
    unresolvedJobsTotal: registry.counter(
      'wp_unresolved_jobs_total',
      'Jobs moved to needs_reconcile by the reaper, pending human/reconciler resolution',
    ),
    contentGuardTripsTotal: registry.counter(
      'wp_content_guard_trips_total',
      'Content-guard pipeline trips (terminal disposal or deferral), by reason (label name: reason)',
      ['reason'],
    ),
    optoutCancelledJobsTotal: registry.counter(
      'wp_optout_cancelled_jobs_total',
      'Jobs disposed by the guard pipeline specifically for OPT_OUT',
    ),
    sendLoopIterationErrorsTotal: registry.counter(
      'wp_send_loop_iteration_errors_total',
      'Send-loop iterations whose runOneIteration call rejected, by the rejecting error name (label name: reason)',
      ['reason'],
    ),
    sendErrorsTotal: registry.counter(
      'wp_send_errors_total',
      'Failed send attempts by classified error class',
      ['error_class'],
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
