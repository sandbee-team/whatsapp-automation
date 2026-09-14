import * as React from 'react';
import { Card, CardBody, CardHeader, CardTitle, DonutChart, useT } from '@wp/ui';
import { deriveOutcomeSegments } from '../dashboard-derive.js';
import type { QueueStatus } from '../../wallet/api.js';

/**
 * DashboardOutcomesCard (2026-09-08 panel refresh, unit S2) - "Today's
 * outcomes": a `DonutChart` of the workspace's `sentToday`/`failedToday`/
 * `waiting` counters (spec section 5.4). Centre shows the total plus
 * "messages", or the honest "Nothing sent yet today" line when every
 * segment is 0 - never a fabricated non-zero total.
 */
export interface DashboardOutcomesCardProps {
  workspace: QueueStatus['workspace'] | undefined;
}

export function DashboardOutcomesCard({
  workspace,
}: DashboardOutcomesCardProps): React.JSX.Element {
  const t = useT();
  const segments = deriveOutcomeSegments({
    sentToday: workspace?.sentToday ?? 0,
    failedToday: workspace?.failedToday ?? 0,
    waiting: workspace?.waiting ?? 0,
  });
  const total = segments.reduce((acc, segment) => acc + segment.value, 0);

  const labelledSegments = segments.map((segment) => ({
    ...segment,
    label: t(`dashboard.outcomes.segment.${segment.id}` as never),
  }));

  return (
    <Card data-testid="dashboard-outcomes-card">
      <CardHeader>
        <CardTitle>{t('dashboard.outcomes.cardTitle')}</CardTitle>
      </CardHeader>
      <CardBody>
        <DonutChart
          label={t('dashboard.outcomes.label')}
          segments={labelledSegments}
          centre={
            total === 0 ? (
              <span className="text-sm text-muted">{t('dashboard.outcomes.centre.empty')}</span>
            ) : (
              <span className="flex flex-col items-center">
                <span className="text-2xl font-semibold tabular-nums text-fg">{total}</span>
                <span className="text-xs text-muted">
                  {t('dashboard.outcomes.centre.messages')}
                </span>
              </span>
            )
          }
        />
      </CardBody>
    </Card>
  );
}
