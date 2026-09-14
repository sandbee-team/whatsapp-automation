import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { TransportSendError } from '../../provider/provider.types.js';
import { bindQueueMetrics } from './metrics.js';
import { recordSendFailure } from './send-failure-metrics.js';

/**
 * send-failure-metrics.test.ts (P25 U1b gap-fill; moved out of
 * `metrics.test.ts` alongside `recordSendFailure` itself - see
 * `send-failure-metrics.ts`'s own header for why).
 */
describe('recordSendFailure', () => {
  it('record_send_failure_increments_both_attempts_and_error_class', async () => {
    const registry = createMetricsRegistry();
    const handles = bindQueueMetrics(registry);
    const failedError = new TransportSendError('rate_limited', 'too many requests');

    recordSendFailure(handles, 'failed', failedError);

    const attempts = await handles.sendAttemptsTotal.get();
    expect(attempts.values.find((v) => v.labels.result === 'failed')?.value).toBe(1);
    const errors = await handles.sendErrorsTotal.get();
    expect(errors.values.find((v) => v.labels.error_class === 'rate_limited')?.value).toBe(1);

    const timedOutError = new TransportSendError('transient', 'send timed out');
    recordSendFailure(handles, 'timed_out', timedOutError);

    const attemptsAfter = await handles.sendAttemptsTotal.get();
    expect(attemptsAfter.values.find((v) => v.labels.result === 'timed_out')?.value).toBe(1);
    const errorsAfter = await handles.sendErrorsTotal.get();
    expect(errorsAfter.values.find((v) => v.labels.error_class === 'transient')?.value).toBe(1);
  });
});
