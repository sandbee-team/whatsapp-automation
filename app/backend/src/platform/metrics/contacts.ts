import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/contacts.ts (P20 Unit U5, step 6) - registers the three
 * contacts/import Prometheus metrics. No `client_id`/`instance_id` label on
 * any of them (same cardinality discipline as `wallet-metrics.ts`):
 *
 *   - `wp_contacts_imported_total{result}` (counter) - one increment per
 *     import job outcome (`done`/`failed`), from `import-runner.ts`.
 *   - `wp_contact_import_rows_total{result}` (counter) - one increment per
 *     per-record outcome within a batch (`imported`/`updated`/`duplicate`/
 *     `invalid`/`opted_out_preserved`).
 *   - `wp_optout_mirror_drift_total` (counter, no label) - incremented by
 *     U7/U8's mirror reconciler when `contacts.opt_out_state` drifts from
 *     the `opt_outs` authority; owned here so both units share one metric
 *     definition instead of each registering their own.
 *
 * Same idempotent-registration WeakMap pattern as `wallet-metrics.ts`.
 */
export interface ContactsMetricsHandles {
  contactsImportedTotal: ReturnType<MetricsRegistry['counter']>;
  contactImportRowsTotal: ReturnType<MetricsRegistry['counter']>;
  optoutMirrorDriftTotal: ReturnType<MetricsRegistry['counter']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, ContactsMetricsHandles>();

export function bindContactsMetrics(
  registry: MetricsRegistry = defaultMetrics,
): ContactsMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const contactsImportedTotal = registry.counter(
    'wp_contacts_imported_total',
    'Contact import job outcomes, by result',
    ['result'],
  );
  const contactImportRowsTotal = registry.counter(
    'wp_contact_import_rows_total',
    'Contact import per-record outcomes, by result',
    ['result'],
  );
  const optoutMirrorDriftTotal = registry.counter(
    'wp_optout_mirror_drift_total',
    'Count of contacts.opt_out_state mirror drift corrections against the opt_outs authority',
  );

  const handles: ContactsMetricsHandles = {
    contactsImportedTotal,
    contactImportRowsTotal,
    optoutMirrorDriftTotal,
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
