import * as React from 'react';
import { CheckCircle2, PauseCircle, TriangleAlert } from 'lucide-react';
import { Card, KpiStat, useT } from '@wp/ui';
import type { InstanceListItem } from '../use-instance-list.js';

/**
 * InstancesSummaryStrip (2026-09-08 panel refresh, unit S4) - the numbers
 * screen's summary strip (spec section 7): Connected / Needs attention /
 * Parked counts, each a `KpiStat` inside a `Card padding="sm"`. Rendered only
 * when at least one number exists (the caller decides that, matching
 * `InstancesScreen`'s existing loading/empty/error branches). Counts are
 * derived from each item's card the same way `use-instance-list.ts` sorts -
 * a card still loading/failed counts toward neither bucket, so the strip
 * never fabricates a state for data it does not have yet.
 */
export interface InstancesSummaryStripProps {
  items: InstanceListItem[];
}

interface SummaryCounts {
  connected: number;
  needsAttention: number;
  parked: number;
}

export function deriveSummaryCounts(items: InstanceListItem[]): SummaryCounts {
  return items.reduce<SummaryCounts>(
    (acc, item) => {
      const card = item.card;
      if (!card) return acc;
      if (card.needsUserAction) acc.needsAttention += 1;
      else if (card.parked) acc.parked += 1;
      else if (card.healthState === 'connected') acc.connected += 1;
      return acc;
    },
    { connected: 0, needsAttention: 0, parked: 0 },
  );
}

export function InstancesSummaryStrip({ items }: InstancesSummaryStripProps): React.JSX.Element {
  const t = useT();
  const counts = deriveSummaryCounts(items);

  return (
    <div data-testid="instances-summary-strip" className="grid gap-4 sm:grid-cols-3">
      <Card padding="sm">
        <KpiStat
          data-testid="instances-summary-connected"
          label={t('instances.summary.connected')}
          value={String(counts.connected)}
          numericValue={counts.connected}
          icon={<CheckCircle2 aria-hidden="true" size={16} strokeWidth={1.75} />}
          tone="success"
        />
      </Card>
      <Card padding="sm">
        <KpiStat
          data-testid="instances-summary-needs-attention"
          label={t('instances.summary.needsAttention')}
          value={String(counts.needsAttention)}
          numericValue={counts.needsAttention}
          icon={<TriangleAlert aria-hidden="true" size={16} strokeWidth={1.75} />}
          tone="danger"
        />
      </Card>
      <Card padding="sm">
        <KpiStat
          data-testid="instances-summary-parked"
          label={t('instances.summary.parked')}
          value={String(counts.parked)}
          numericValue={counts.parked}
          icon={<PauseCircle aria-hidden="true" size={16} strokeWidth={1.75} />}
          tone="warning"
        />
      </Card>
    </div>
  );
}
