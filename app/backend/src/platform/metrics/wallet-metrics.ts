import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/wallet-metrics.ts (P18 Unit U2) - registers the four
 * wallet Prometheus metrics. No `client_id`/`instance_id` label on any of
 * them, and no per-client balance gauge at all - a balance gauge is
 * tenant-scoped cardinality, which is only allowed on the four named
 * `INSTANCE_LABELLED_GAUGES` in `@wp/server-kit`'s metric-policy.ts (none of
 * these four is one of them, so a tenant-scoped label would throw at
 * registration). Per-client figures instead come from `wallet_daily_summary`
 * over SQL (ADR 0019 S10).
 *
 *   - `wp_wallet_debits_total{price_key}` (counter) - one debit event.
 *   - `wp_wallet_refunds_total{reason}` (counter) - one refund event.
 *   - `wp_wallet_drift_minor` (gauge, no label) - checkpoint-vs-ledger drift.
 *   - `wp_wallet_clients_empty` (gauge, no label) - count of clients whose
 *     wallet is in the `empty` state.
 *   - `wp_wallet_topups_total{status}` (counter, P19 Unit U4) - one
 *     increment per tenant top-up request, by its `topup_status` label
 *     (`pending` at submission time; a later staff review re-labels via a
 *     fresh increment at `approved`/`rejected` - this file only owns the
 *     metric, never the review flow itself). `status` is already on
 *     `@wp/server-kit`'s `ALLOWED_LABELS` allow-list - no policy change
 *     needed.
 *
 * P28 Unit U3a (step 4): `wp_internal_audit_write_failures_total{route}`
 * (the P19-era best-effort-audit-write counter) is REMOVED - the audit row
 * is now transactional with every mutation via `modules/internal/
 * with-staff-mutation.ts#withStaffMutation`, so "the audit write failed
 * after money already committed" is no longer a reachable state; a failed
 * audit write now rolls the whole mutation back instead. See
 * `platform/metrics/staff-metrics.ts` for the mutation-count metric that
 * replaces it (`wp_staff_mutations_total{action}`).
 *
 * Same idempotent-registration WeakMap pattern as
 * `platform/metrics/lease-metrics.ts`.
 */
export interface WalletMetricsHandles {
  debitsTotal: ReturnType<MetricsRegistry['counter']>;
  refundsTotal: ReturnType<MetricsRegistry['counter']>;
  driftMinor: ReturnType<MetricsRegistry['gauge']>;
  clientsEmpty: ReturnType<MetricsRegistry['gauge']>;
  topupsTotal: ReturnType<MetricsRegistry['counter']>;
  incDebit: (priceKey: string) => void;
  incRefund: (reason: string) => void;
  setDrift: (minor: number) => void;
  setClientsEmpty: (count: number) => void;
  incTopup: (status: string) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, WalletMetricsHandles>();

export function bindWalletMetrics(
  registry: MetricsRegistry = defaultMetrics,
): WalletMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const debitsTotal = registry.counter(
    'wp_wallet_debits_total',
    'Wallet debit events, by price key',
    ['price_key'],
  );
  const refundsTotal = registry.counter(
    'wp_wallet_refunds_total',
    'Wallet refund events, by reason',
    ['reason'],
  );
  const driftMinor = registry.gauge(
    'wp_wallet_drift_minor',
    'Checkpoint-vs-ledger wallet balance drift, in minor units (paise)',
  );
  const clientsEmpty = registry.gauge(
    'wp_wallet_clients_empty',
    'Count of clients whose wallet is currently in the empty state',
  );
  const topupsTotal = registry.counter(
    'wp_wallet_topups_total',
    'Tenant top-up requests, by status',
    ['status'],
  );

  const handles: WalletMetricsHandles = {
    debitsTotal,
    refundsTotal,
    driftMinor,
    clientsEmpty,
    topupsTotal,
    incDebit: (priceKey: string) => {
      debitsTotal.inc({ price_key: priceKey });
    },
    incRefund: (reason: string) => {
      refundsTotal.inc({ reason });
    },
    setDrift: (minor: number) => {
      driftMinor.set(minor);
    },
    setClientsEmpty: (count: number) => {
      clientsEmpty.set(count);
    },
    incTopup: (status: string) => {
      topupsTotal.inc({ status });
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
