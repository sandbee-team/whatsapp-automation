import { Card, CardBody, CardHeader, CardTitle, useT } from '@wp/ui';
import { useQueueStatus } from '../api.js';

/**
 * QueueStatusCard (P19 Unit U5, step 9) - renders `GET /v1/queue-status`'s
 * workspace totals (waiting/sent today/failed today) under the wallet
 * banner on the dashboard. Zero/loading state renders the real (possibly
 * zero) numbers, same honest-zero-state discipline as `EmptyDashboard`
 * (never a placeholder claim).
 */
export function QueueStatusCard(): React.JSX.Element {
  const t = useT();
  const { data, isLoading } = useQueueStatus();
  const workspace = data?.workspace ?? {
    waiting: 0,
    sentToday: 0,
    failedToday: 0,
    // PAISE, decimal string wire type (queueStatusWorkspaceSchema) - never
    // rendered on this card (only the counts are), kept here only to match
    // QueueStatusWorkspace's own shape.
    spentTodayMinor: '0',
  };

  return (
    <Card data-testid="queue-status-card">
      <CardHeader>
        <CardTitle>{t('queueStatus.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <dl className="grid grid-cols-3 gap-4">
          <div>
            <dt className="text-xs font-ui text-muted">{t('queueStatus.waiting')}</dt>
            <dd data-testid="queue-status-waiting" className="text-2xl font-semibold text-fg">
              {isLoading ? '…' : workspace.waiting}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-ui text-muted">{t('queueStatus.sentToday')}</dt>
            <dd data-testid="queue-status-sent-today" className="text-2xl font-semibold text-fg">
              {isLoading ? '…' : workspace.sentToday}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-ui text-muted">{t('queueStatus.failedToday')}</dt>
            <dd data-testid="queue-status-failed-today" className="text-2xl font-semibold text-fg">
              {isLoading ? '…' : workspace.failedToday}
            </dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}
