import { Badge, KpiStat, Progress, useT } from '@wp/ui';
import type { BroadcastDetail } from '../api.js';
import { paiseToRupees } from '../../wallet/money.js';

/**
 * Funnel (P23a Unit U5; P23a C1 fix round NOTE 8; P26b U4 restyle) - pure
 * render of a `BroadcastDetail`'s partition counters as `KpiStat` tiles plus
 * a horizontal stage bar (no fetching - the caller owns `useBroadcast`).
 * Every number shown is DERIVED from the exact counters the contract ships,
 * never re-summed from a different source: `queued` = pending + queued
 * (with `deferred` shown as a display-only sub-line, per
 * `campaignCountersSchema`'s own doc comment - it is never a stored status,
 * only a live pacing-deny snapshot); `sent`/`delivered` are CUMULATIVE (a
 * message that has reached `read` also counts toward `sent` and `delivered`
 * - the same "later stage implies every earlier stage" idiom a funnel chart
 * requires). Each tile keeps its exact `funnel-{key}` test id and the
 * `{label}: {count}` text content the existing suite asserts on.
 * `chargedMinor` uses the shared `paiseToRupees` formatter
 * (`features/wallet/money.ts`) - the ONE BIGINT paise-to-display
 * implementation.
 */
export interface FunnelProps {
  detail: BroadcastDetail;
}

interface FunnelStage {
  key: 'total' | 'queued' | 'sent' | 'delivered' | 'read' | 'skipped' | 'failed' | 'cancelled';
  labelKey: Parameters<ReturnType<typeof useT>>[0];
  count: number;
}

export function Funnel({ detail }: FunnelProps): React.JSX.Element {
  const t = useT();
  const counters = detail.counters;

  const queuedCount = counters.pending + counters.queued;
  const sentCumulative = counters.sent + counters.delivered + counters.read;
  const deliveredCumulative = counters.delivered + counters.read;

  const stages: FunnelStage[] = [
    { key: 'total', labelKey: 'broadcasts.funnel.total', count: counters.total },
    { key: 'queued', labelKey: 'broadcasts.funnel.queued', count: queuedCount },
    { key: 'sent', labelKey: 'broadcasts.funnel.sent', count: sentCumulative },
    { key: 'delivered', labelKey: 'broadcasts.funnel.delivered', count: deliveredCumulative },
    { key: 'read', labelKey: 'broadcasts.funnel.read', count: counters.read },
    { key: 'skipped', labelKey: 'broadcasts.funnel.skipped', count: counters.skipped },
    { key: 'failed', labelKey: 'broadcasts.funnel.failed', count: counters.failed },
    { key: 'cancelled', labelKey: 'broadcasts.funnel.cancelled', count: counters.cancelled },
  ];

  const progressValue = counters.total > 0 ? sentCumulative : 0;

  return (
    <section data-testid="broadcast-funnel" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold font-ui text-fg">{t('broadcasts.funnel.title')}</h3>
        <Badge tone="info">{t(`broadcasts.status.${detail.status}`)}</Badge>
      </div>

      <Progress
        value={counters.total > 0 ? progressValue : null}
        max={Math.max(counters.total, 1)}
        label={t('broadcasts.funnel.sent')}
        valueText={`${String(sentCumulative)}/${String(counters.total)}`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => (
          <div
            key={stage.key}
            data-testid={`funnel-${stage.key}`}
            className="rounded-lg border border-border bg-surface p-3"
          >
            <span className="sr-only">
              {t(stage.labelKey)}: {stage.count}
            </span>
            <KpiStat label={t(stage.labelKey)} value={String(stage.count)} aria-hidden="true" />
            {stage.key === 'queued' && counters.deferred > 0 ? (
              <p className="mt-1 text-xs font-ui text-muted">
                {t('broadcasts.funnel.deferredOfWhich', { count: counters.deferred })}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <p data-testid="funnel-receipts-caveat" className="text-sm font-ui text-muted">
        {t('broadcasts.funnel.receiptsLowerBound')}
      </p>
      <p className="text-sm font-ui text-fg">
        {t('broadcasts.funnel.charged', { amount: paiseToRupees(counters.chargedMinor) })}
      </p>
    </section>
  );
}
