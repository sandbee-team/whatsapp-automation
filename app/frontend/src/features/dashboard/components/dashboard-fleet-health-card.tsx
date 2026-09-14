import * as React from 'react';
import { Badge, Card, CardBody, CardHeader, CardTitle, ProgressRing, useT } from '@wp/ui';
import { deriveFleetHealth, type HealthBand } from '../dashboard-derive.js';
import type { InstanceListItem } from '../../instances/use-instance-list.js';

/**
 * DashboardFleetHealthCard (2026-09-08 panel refresh, unit S2) - the mean
 * `healthScore` across every listed number as a `ProgressRing`, plus a side
 * list of counts per `healthBand` as `Badge`s (spec section 5). Empty state
 * when no numbers are linked yet - never a fabricated "100" for a fleet of
 * zero.
 */
const BAND_ORDER: HealthBand[] = ['HEALTHY', 'WATCH', 'DEGRADED', 'CRITICAL'];
const BAND_TONE: Record<HealthBand, 'success' | 'info' | 'warning' | 'danger'> = {
  HEALTHY: 'success',
  WATCH: 'info',
  DEGRADED: 'warning',
  CRITICAL: 'danger',
};

export interface DashboardFleetHealthCardProps {
  items: InstanceListItem[];
}

export function DashboardFleetHealthCard({
  items,
}: DashboardFleetHealthCardProps): React.JSX.Element {
  const t = useT();
  const { meanScore, bandCounts } = deriveFleetHealth(items);

  return (
    <Card data-testid="dashboard-fleet-health">
      <CardHeader>
        <CardTitle>{t('dashboard.fleetHealth.cardTitle')}</CardTitle>
      </CardHeader>
      <CardBody>
        {items.length === 0 ? (
          <p className="text-sm text-muted">{t('dashboard.fleetHealth.empty')}</p>
        ) : (
          <div className="flex items-center gap-6">
            <ProgressRing
              value={meanScore}
              label={t('dashboard.fleetHealth.label', { score: meanScore })}
            >
              <span className="text-2xl font-semibold tabular-nums text-fg">{meanScore}</span>
            </ProgressRing>
            <ul role="list" className="flex flex-1 flex-col gap-2">
              {BAND_ORDER.map((band) => (
                <li key={band} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-fg">
                    {t(`dashboard.fleetHealth.band.${band}` as never)}
                  </span>
                  <Badge tone={BAND_TONE[band]}>{bandCounts[band]}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
