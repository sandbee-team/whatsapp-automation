import { useQueries } from '@tanstack/react-query';
import { useQueueStatus } from '../wallet/api.js';
import { fetchInstanceCard, type InstanceCardResult } from './api.js';
import { instanceKeys } from './keys.js';

/**
 * use-instance-list.ts (P26b, main session) - THE one instance list for the
 * panel. There is no `GET /v1/instances` route (P11 gap); `GET
 * /v1/queue-status` already returns every non-deleted instance of the
 * workspace (see `db/queries/queue-status.sql`), so the list is that response
 * joined client-side with each instance's card (`GET /v1/instances/:id/card`,
 * cached under `instanceKeys.card(id)`, which the SSE invalidation map already
 * refreshes on `instance.health_changed`). Shared by the dashboard, the
 * numbers screen, the composer's number picker and the community-chat picker
 * so no unit invents a second list. Cards load independently: an item whose
 * card is still loading (or failed) is still listed with its queue counters.
 */
type QueueStatusInstance = NonNullable<
  ReturnType<typeof useQueueStatus>['data']
>['instances'][number];

export interface InstanceListItem {
  instanceId: string;
  /** Queue counters straight from `/v1/queue-status`. */
  queue: QueueStatusInstance;
  /** The card, or `null` while it loads / when its fetch failed. */
  card: InstanceCardResult | null;
  cardStatus: 'pending' | 'error' | 'success';
}

export interface InstanceList {
  items: InstanceListItem[];
  /** True until the queue-status list itself has loaded. */
  isLoading: boolean;
  /** True when the queue-status list failed (cards failing is per-item). */
  isError: boolean;
  /** True while any card is still loading (list already rendered). */
  isCardsLoading: boolean;
  refetch: () => void;
}

/** Sort: needs-action first, then online before parked, then by label, then by id for stability. */
export function sortInstanceItems(items: InstanceListItem[]): InstanceListItem[] {
  return [...items].sort((a, b) => {
    const aAction = a.card?.needsUserAction ? 0 : 1;
    const bAction = b.card?.needsUserAction ? 0 : 1;
    if (aAction !== bAction) return aAction - bAction;
    const aParked = a.card?.parked ? 1 : 0;
    const bParked = b.card?.parked ? 1 : 0;
    if (aParked !== bParked) return aParked - bParked;
    const byLabel = (a.card?.label ?? '').localeCompare(b.card?.label ?? '');
    if (byLabel !== 0) return byLabel;
    return a.instanceId.localeCompare(b.instanceId);
  });
}

export function useInstanceList(): InstanceList {
  const queueStatus = useQueueStatus();
  const queueInstances = queueStatus.data?.instances ?? [];

  const cards = useQueries({
    queries: queueInstances.map((instance) => ({
      queryKey: instanceKeys.card(instance.instanceId),
      queryFn: () => fetchInstanceCard(instance.instanceId),
    })),
  });

  const items = sortInstanceItems(
    queueInstances.map((instance, index) => {
      const card = cards[index];
      return {
        instanceId: instance.instanceId,
        queue: instance,
        card: card?.data ?? null,
        cardStatus: card?.status ?? 'pending',
      };
    }),
  );

  return {
    items,
    isLoading: queueStatus.isLoading,
    isError: queueStatus.isError,
    isCardsLoading: cards.some((card) => card.isLoading),
    refetch: () => {
      void queueStatus.refetch();
      for (const card of cards) void card.refetch();
    },
  };
}
