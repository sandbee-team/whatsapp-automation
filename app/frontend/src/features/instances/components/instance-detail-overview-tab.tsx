import * as React from 'react';
import { KpiStat, useT } from '@wp/ui';
import type { InstanceCardResult } from '../api.js';

/**
 * InstanceDetailOverviewTab (P26b U3) - the Overview tab's KPI tiles: today
 * sent / daily cap, new conversations / cap, queue depth, oldest queued age,
 * sending window, next-send countdown. Reads the SAME `InstanceCardResult`
 * the card already fetched (no second fetch) - every number here is a
 * DERIVED display of fields the card contract already returns, never
 * independently computed.
 */
export function InstanceDetailOverviewTab({
  data,
}: {
  data: InstanceCardResult;
}): React.JSX.Element {
  const t = useT();
  const notSending =
    data.parked || data.healthState === 'paused' || data.nextSendEarliestAt === null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiStat
        label={t('instances.detail.overview.todaySent')}
        value={`${String(data.todaySent)}/${String(data.effDailyCap)}`}
      />
      <KpiStat
        label={t('instances.detail.overview.newConversations')}
        value={`${String(data.newConversationsToday)}/${String(data.effNewConvCap)}`}
      />
      <KpiStat
        label={t('instances.detail.overview.queueDepth')}
        value={
          data.queueDepthCapped ? t('instances.card.queueDepthCapped') : String(data.queueDepth)
        }
      />
      <KpiStat
        label={t('instances.detail.overview.oldestQueuedAge')}
        value={String(data.oldestQueuedAgeSeconds ?? 0)}
      />
      <KpiStat
        label={t('instances.detail.overview.sendingWindow')}
        value={`${data.sendingWindow.start}–${data.sendingWindow.end} ${data.sendingWindow.tz}`}
      />
      <KpiStat
        label={t('instances.detail.overview.nextSend')}
        value={notSending ? t('instances.card.notSending') : (data.nextSendEarliestAt ?? '—')}
      />
    </div>
  );
}
