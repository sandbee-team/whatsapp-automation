import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Phone } from 'lucide-react';
import {
  BarList,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  EmptyState,
  SkeletonRows,
  StatusDot,
  useT,
} from '@wp/ui';
import type { BarListRow } from '@wp/ui';
import { useInstanceList } from '../../instances/use-instance-list.js';
import type { InstanceListItem } from '../../instances/use-instance-list.js';

/**
 * DashboardNumbersCard (2026-09-08 panel refresh, unit S2) - REPLACES the
 * old numbers grid on the dashboard (spec section 5.4): a `BarList` ranking
 * of up to 6 numbers by today's send progress (`todaySent`/`effDailyCap`),
 * sorted exactly as `useInstanceList` sorts (needs-action first). The
 * numbers screen keeps the full instance cards; this card is a compact
 * summary only, never a second source of truth. Own loading/empty/error
 * states so one failing query never blanks the rest of the dashboard.
 */
const MAX_ROWS = 6;

function healthTone(item: InstanceListItem): 'success' | 'warning' | 'danger' {
  const card = item.card;
  if (!card) return 'danger';
  if (card.healthState === 'connected') return 'success';
  if (card.parked || card.needsUserAction) return 'warning';
  return 'danger';
}

export function DashboardNumbersCard(): React.JSX.Element {
  const t = useT();
  const { items, isLoading, isError, refetch } = useInstanceList();

  const rows: BarListRow[] = items.slice(0, MAX_ROWS).map((item) => {
    const label = item.card?.label ?? item.instanceId;
    return {
      id: item.instanceId,
      label,
      value: item.card?.todaySent ?? 0,
      max: Math.max(1, item.card?.effDailyCap ?? 1),
      tone: healthTone(item),
      leading: <StatusDot tone={healthTone(item)} label={label} />,
      meta: t('dashboard.numbers.meta.waiting', { count: item.queue.waiting }),
    };
  });

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        eyebrow={t('instances.list.title')}
        actions={
          <Link to="/instances" data-testid="dashboard-numbers-view-all">
            {t('dashboard.numbers.viewAll')}
          </Link>
        }
      >
        <CardTitle>{t('dashboard.numbers.cardTitle')}</CardTitle>
      </CardHeader>
      <CardBody>
        {isError ? (
          <ErrorState
            data-testid="dashboard-numbers-error"
            title={t('instances.numbers.grid.error.title')}
            body={t('instances.numbers.grid.error.body')}
            retryAction={
              <Button variant="secondary" size="sm" onClick={refetch}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : isLoading ? (
          <SkeletonRows data-testid="dashboard-numbers-loading" rows={MAX_ROWS} columns={1} />
        ) : items.length === 0 ? (
          <EmptyState
            data-testid="dashboard-numbers-empty"
            compact
            icon={<Phone aria-hidden="true" size={32} />}
            title={t('instances.numbers.grid.empty.title')}
            body={t('instances.numbers.grid.empty.body')}
            action={
              <Link to="/instances" data-testid="connect-a-number-cta">
                <Button>{t('dashboard.empty.cta')}</Button>
              </Link>
            }
          />
        ) : (
          <BarList rows={rows} />
        )}
      </CardBody>
    </Card>
  );
}
