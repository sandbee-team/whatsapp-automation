import type { TransportSendError } from '../../provider/provider.types.js';
import type { QueueMetricsHandles } from './metrics.js';

/**
 * send-failure-metrics.ts (P25 U1b gap-fill, split out of `metrics.ts`) -
 * `recordSendFailure` is the ONLY consumer of `TransportSendError` in this
 * area, and `metrics.ts` is directly reachable from `roles/cron.ts` via
 * `cron-wiring.ts`'s `bindQueueMetrics` import (P11 Unit U5) - the cron
 * process owns no socket/provider connection (see `cron-loop-shape.test.ts`'s
 * own header), so a `provider/provider.types.js` import must never live in
 * `metrics.ts` itself. This sibling module is imported only by
 * `send-loop.ts#dispatchAndResolve` (never by cron-wiring), keeping the
 * cron relative-import graph clear of `provider/**` while `metrics.ts`
 * keeps registering `wp_send_errors_total{error_class}` (module path in
 * `packages/domain/src/obs/metric-inventory-session.ts` is unaffected - the
 * counter's registration site did not move, only this incrementing helper).
 */

/** Records one failed/timed-out dispatch outcome on BOTH `sendAttemptsTotal{result}` and `sendErrorsTotal{error_class}` in a single call - `send-loop.ts#dispatchAndResolve`'s one call site for this. */
export function recordSendFailure(
  metrics: QueueMetricsHandles,
  outcome: 'failed' | 'timed_out',
  error: TransportSendError,
): void {
  metrics.sendAttemptsTotal.inc({ result: outcome });
  metrics.sendErrorsTotal.inc({ error_class: error.class });
}
