import * as React from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Badge, Button, IconButton, useT, useToast } from '@wp/ui';
import { notificationKeys } from '../keys.js';
import {
  listNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../api.js';

/**
 * NotificationBell (P17 U5; P26b U3 restyles as `IconButton` + `Badge` +
 * dropdown panel, keeping every test id; P26b C1 fix round MINOR-10/11) -
 * header-mounted unread badge + dropdown list. The badge count comes from
 * `unread-count` (a dedicated cheap endpoint, never derived by counting the
 * list page client-side); the dropdown lists `listNotifications()` via
 * `useInfiniteQuery` (the SAME idiom as `broadcast-list.tsx`'s own list
 * query - a refetch/invalidation REPLACES `data.pages`, it never appends to
 * a parallel `React.useState` mirror, which the previous effect-driven
 * accumulator here did and duplicated pages on invalidation). Mark-read/
 * mark-all mutations invalidate ONLY `notificationKeys` - never an
 * instance/dashboard key (asserted by `lib/sse-invalidation-map.ts`'s own
 * `notification.created` entry) - and BOTH now raise a failure toast
 * (mark-all-read previously had none).
 */
export function NotificationBell(): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);

  const unreadQuery = useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: fetchUnreadCount,
  });

  const listQuery = useInfiniteQuery({
    queryKey: notificationKeys.list(),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listNotifications({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open,
  });

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const invalidateNotifications = (): void => {
    void queryClient.invalidateQueries({ queryKey: notificationKeys.list() });
    void queryClient.invalidateQueries({ queryKey: notificationKeys.unreadCount() });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: invalidateNotifications,
    // No optimistic write (nothing here flips `readAt` ahead of the server)
    // so there is nothing to roll back on failure - but the user still
    // needs to know the click did not take effect, never a silent no-op.
    onError: () => {
      showToast({ tone: 'danger', title: t('notifications.bell.markReadError') });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: invalidateNotifications,
    onError: () => {
      showToast({ tone: 'danger', title: t('notifications.bell.markAllReadError') });
    },
  });

  const unreadCount = unreadQuery.data?.count ?? 0;

  return (
    <div className="relative" data-testid="notification-bell">
      <IconButton
        aria-label={t('notifications.bell.label')}
        data-testid="notification-bell-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Bell aria-hidden="true" size={18} />
        {unreadCount > 0 ? (
          <Badge
            tone="accent"
            size="sm"
            data-testid="notification-unread-badge"
            className="absolute -right-1 -top-1"
          >
            {unreadCount}
          </Badge>
        ) : null}
      </IconButton>

      {open ? (
        <div
          data-testid="notification-dropdown"
          role="menu"
          className="absolute right-0 z-10 mt-2 flex w-80 flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold font-ui text-fg">
              {t('notifications.bell.title')}
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="notification-mark-all-read"
              disabled={unreadCount === 0}
              loading={markAllReadMutation.isPending}
              loadingLabel={t('common.loading')}
              onClick={() => markAllReadMutation.mutate()}
            >
              {t('notifications.bell.markAllRead')}
            </Button>
          </div>

          {listQuery.isLoading ? (
            <p data-testid="notification-loading" className="text-sm font-ui text-muted">
              {t('common.loading')}
            </p>
          ) : null}

          {listQuery.isError ? (
            <p
              role="alert"
              data-testid="notification-error"
              className="text-sm font-ui text-danger"
            >
              {t('notifications.bell.error')}
            </p>
          ) : null}

          {!listQuery.isLoading && !listQuery.isError && items.length === 0 ? (
            <p data-testid="notification-empty" className="text-sm font-ui text-muted">
              {t('notifications.bell.empty')}
            </p>
          ) : null}

          {items.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  data-testid={`notification-item-${item.id}`}
                  className="flex items-start justify-between gap-2 rounded-md border border-border p-2"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-ui text-fg">{item.title}</span>
                    {item.readAt === null ? (
                      <Badge tone="info" size="sm">
                        {t('notifications.bell.unreadBadge')}
                      </Badge>
                    ) : null}
                  </div>
                  {item.readAt === null ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid={`notification-mark-read-${item.id}`}
                      onClick={() => markReadMutation.mutate(item.id)}
                    >
                      {t('notifications.bell.markRead')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {listQuery.hasNextPage ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="notification-load-more"
              loading={listQuery.isFetchingNextPage}
              loadingLabel={t('common.loading')}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {t('notifications.bell.loadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
