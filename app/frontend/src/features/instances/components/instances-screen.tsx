import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Phone } from 'lucide-react';
import { Button, EmptyState, ErrorState, Skeleton, Stagger, useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { useRealtimeConnectionState } from '../../../lib/use-realtime-connection-state.js';
import { useInstanceList } from '../use-instance-list.js';
import { ConnectSheet } from '../connect/ConnectSheet.js';
import { InstanceCard } from './instance-card.js';
import { InstancesSummaryStrip } from './instances-summary-strip.js';
import { WhyDrawer } from './why-drawer.js';
import { fetchHealthWhy, type HealthWhyResult } from '../api.js';

/**
 * InstancesScreen (P26b U3; 2026-09-08 panel refresh, unit S4) - the
 * `/instances` route's component: a `PageHeader` with the connect CTA
 * (`instances-connect-cta`), an `InstancesSummaryStrip` (Connected/Needs
 * attention/Parked counts) shown once at least one number exists, a grid of
 * `InstanceCard`s from `useInstanceList` inside a `Stagger` enter animation
 * (a card click opens its `WhyDrawer` only when the user asks "why";
 * navigating to the detail route is a separate explicit click on the card's
 * title area), an `EmptyState` while zero numbers exist (CTA stays visible),
 * and the existing `ConnectSheet` flow wired unchanged (`useConnectFlow`/
 * `useLinkStream` keep every `connect-*`/`qr-*`/`pairing-code-*`/`code-*`
 * test id - this file only changes the surrounding chrome).
 */
export function InstancesScreen(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const realtimeConnectionState = useRealtimeConnectionState();
  const realtimeState = realtimeConnectionState === 'live' ? 'connected' : 'disconnected';
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const { items, isLoading, isError, refetch } = useInstanceList();
  const [whyDrawerInstanceId, setWhyDrawerInstanceId] = React.useState<string | null>(null);
  const [whyData, setWhyData] = React.useState<HealthWhyResult | undefined>(undefined);

  const openWhyDrawer = (instanceId: string): void => {
    setWhyDrawerInstanceId(instanceId);
    void fetchHealthWhy(instanceId).then(setWhyData);
  };

  return (
    <div data-testid="instances-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('instances.list.title')}
        description={t('instances.list.subtitle')}
        actions={
          <Button
            type="button"
            data-testid="instances-connect-cta"
            onClick={() => setSheetOpen(true)}
          >
            {t('instances.list.connectCta')}
          </Button>
        }
      />

      {!isError && !isLoading && items.length > 0 ? <InstancesSummaryStrip items={items} /> : null}

      {isError ? (
        <ErrorState
          data-testid="instances-numbers-error"
          title={t('instances.numbers.grid.error.title')}
          body={t('instances.numbers.grid.error.body')}
          retryAction={
            <Button variant="secondary" size="sm" onClick={refetch}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : isLoading ? (
        <div
          data-testid="instances-numbers-loading"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-48 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          data-testid="instances-numbers-empty"
          icon={<Phone aria-hidden="true" size={32} />}
          title={t('instances.numbers.grid.empty.title')}
          body={t('instances.numbers.grid.empty.body')}
          action={
            <Button type="button" onClick={() => setSheetOpen(true)}>
              {t('instances.list.connectCta')}
            </Button>
          }
        />
      ) : (
        <div
          data-testid="instances-numbers-grid"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          <Stagger variant="rise" className="contents">
            {items
              .filter((item) => item.card !== null)
              .map((item) => (
                <div
                  key={item.instanceId}
                  data-testid={`instance-card-link-${item.instanceId}`}
                  role="link"
                  tabIndex={0}
                  className="cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() =>
                    void navigate({ to: '/instances/$id', params: { id: item.instanceId } })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      void navigate({ to: '/instances/$id', params: { id: item.instanceId } });
                    }
                  }}
                >
                  <InstanceCard
                    data={item.card!}
                    onOpenWhyDrawer={() => openWhyDrawer(item.instanceId)}
                  />
                </div>
              ))}
          </Stagger>
        </div>
      )}

      <WhyDrawer
        open={whyDrawerInstanceId !== null}
        onOpenChange={(open) => {
          if (!open) setWhyDrawerInstanceId(null);
        }}
        data={whyData}
      />

      <ConnectSheet open={sheetOpen} onOpenChange={setSheetOpen} realtimeState={realtimeState} />
    </div>
  );
}
