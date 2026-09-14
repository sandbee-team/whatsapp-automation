import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  SkeletonText,
  useT,
  useToast,
} from '@wp/ui';
import { notificationKeys } from '../../notifications/keys.js';
import { listNotifications, markNotificationRead } from '../../notifications/api.js';

/**
 * RecentActivityCard (P26b U3) - the dashboard's "Recent activity" card:
 * the first page of `GET /v1/notifications`, relative timestamps, mark-read
 * on click. NOT optimistic (fixed in C2 hardening - this doc comment
 * previously claimed an immediate `readAt` flip that the code never
 * performed): the row only updates once the mutation invalidates the shared
 * `notificationKeys` cache, same as `NotificationBell`, so both surfaces
 * stay in sync; a failed mark-read shows a failure toast rather than a
 * silent no-op. Its own loading/empty/error states - never borrows the
 * numbers grid's.
 */
function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

const RECENT_LIMIT = 5;

export function RecentActivityCard(): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: notificationKeys.recent(),
    // No `limit` on the wire: the list contract types it as a number and the
    // route parses the raw query string, so `?limit=5` is rejected with 400.
    // Fetch the default page under the card's own child key (the bell's
    // list() is an infinite query - see notifications/keys.ts) and show five.
    queryFn: () => listNotifications({}),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unreadCount() });
    },
    onError: () => {
      showToast({ tone: 'danger', title: t('notifications.bell.markReadError') });
    },
  });

  return (
    <Card data-testid="recent-activity-card">
      <CardHeader>
        <CardTitle>{t('dashboard.activity.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        {listQuery.isLoading ? (
          <SkeletonText data-testid="recent-activity-loading" lines={4} />
        ) : null}

        {listQuery.isError ? (
          <ErrorState
            data-testid="recent-activity-error"
            title={t('dashboard.activity.error')}
            body={t('common.error.generic')}
          />
        ) : null}

        {!listQuery.isLoading && !listQuery.isError && listQuery.data?.items.length === 0 ? (
          <p data-testid="recent-activity-empty" className="text-sm font-ui text-muted">
            {t('dashboard.activity.empty')}
          </p>
        ) : null}

        {listQuery.data && listQuery.data.items.length > 0 ? (
          <ul className="relative flex flex-col gap-4 pl-2">
            <span aria-hidden="true" className="absolute bottom-2 left-3.5 top-2 w-px bg-border" />
            {listQuery.data.items.slice(0, RECENT_LIMIT).map((item) => (
              <li
                key={item.id}
                data-testid={`recent-activity-item-${item.id}`}
                className="relative flex items-start gap-3 rounded-md p-2 hover:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-muted ring-2 ring-border"
                >
                  <Bell size={12} />
                </span>
                <button
                  type="button"
                  data-testid={`recent-activity-mark-read-${item.id}`}
                  className="flex flex-1 flex-col items-start gap-0.5 text-left"
                  onClick={() => item.readAt === null && markReadMutation.mutate(item.id)}
                >
                  <span className="text-sm font-ui text-fg">{item.title}</span>
                  <span className="text-xs font-ui text-muted">{relativeTime(item.createdAt)}</span>
                </button>
                {item.readAt === null ? (
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
