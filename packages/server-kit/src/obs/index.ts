/**
 * @wp/server-kit/obs - shared pino logger with a field allow-list
 * serializer, plus the metrics registry that enforces the wp_ prefix and
 * the label allow-list.
 */
export type { LogFields } from './log-fields.js';
export { ALLOWED_LOG_FIELDS } from './log-fields.js';
export type { WpLogger } from './logger.js';
export { createLogger, logger } from './logger.js';
export { describeError } from './describe-error.js';
export {
  METRIC_PREFIX,
  ALLOWED_LABELS,
  TENANT_SCOPED_LABELS,
  INSTANCE_LABELLED_GAUGES,
  assertMetricRegistrationAllowed,
} from './metric-policy.js';
export type { CounterMetric, GaugeMetric, HistogramMetric, MetricsRegistry } from './metrics.js';
export { createMetricsRegistry, metrics } from './metrics.js';
