import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonAlert } from 'lucide-react';
import { Alert, Button, useT } from '@wp/ui';
import { notificationKeys } from '../keys.js';
import { listNotifications, markNotificationRead } from '../api.js';

/**
 * NotificationBanner (P17 U5) - an inline, non-dismissing banner for the
 * single most recent unread `critical` notification (e.g. instance paused,
 * logged out). Unlike `@wp/ui`'s `ToastProvider`, this never auto-dismisses
 * on a timer: a critical notification stays visible until the user
 * explicitly marks it read (core invariant: no silently-disappearing
 * action-needed state). Renders nothing while loading, on error, or when
 * there is no unread critical item - never a fabricated placeholder row.
 */
export function NotificationBanner(): React.JSX.Element | null {
  const t = useT();
  const queryClient = useQueryClient();

  const criticalQuery = useQuery({
    queryKey: [...notificationKeys.list(), 'critical-unread'],
    queryFn: () => listNotifications({ unread: true, limit: 1 }),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unreadCount() });
    },
  });

  if (criticalQuery.isLoading || criticalQuery.isError) return null;

  const item = criticalQuery.data?.items.find((row) => row.severity === 'critical');
  if (!item) return null;

  return (
    <Alert
      data-testid="notification-banner"
      tone="danger"
      icon={<OctagonAlert aria-hidden="true" size={16} />}
      title={t('notifications.banner.criticalBadge')}
      body={item.title}
      action={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="notification-banner-mark-read"
          loading={markReadMutation.isPending}
          loadingLabel={t('common.loading')}
          onClick={() => markReadMutation.mutate(item.id)}
        >
          {t('notifications.banner.dismiss')}
        </Button>
      }
    />
  );
}
