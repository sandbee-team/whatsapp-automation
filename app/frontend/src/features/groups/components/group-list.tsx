import * as React from 'react';
import {
  Alert,
  Button,
  EmptyState,
  ErrorState,
  SkeletonRows,
  Table,
  TBody,
  TH,
  THead,
  TR,
  useLocale,
  useT,
} from '@wp/ui';
import { Users } from 'lucide-react';
import { PageHeader } from '../../../components/page-header.js';
import { useGroupList } from '../api.js';
import { useGroupListActions } from '../use-group-list-actions.js';
import { GroupRow } from './group-row.js';
import { GroupCapChip } from './group-cap-chip.js';
import { DeviceBudgetLine } from './device-budget-line.js';
import { EnableSendDialog } from './enable-send-dialog.js';
import { LeaveDialog } from './leave-dialog.js';

/**
 * GroupList (P24 groups-messaging, Unit U5; P26b C1 fix round) - the
 * `/groups` screen body once an instance is selected: header + disclosure
 * (always visible, never behind a toggle), sync toolbar, cap/budget chips,
 * the keyset-paginated group table, and the enable/leave confirm dialogs.
 * All mutation logic (idempotency-key reuse, invalidation, failure toasts)
 * lives in `useGroupListActions` - split out to stay clear of the
 * `max-lines: 300` cap (the `useComposer.ts`/`Composer.tsx` idiom).
 */
export interface GroupListProps {
  instanceId: string;
}

type PendingDialog =
  { kind: 'enable'; groupId: string } | { kind: 'leave'; groupId: string } | null;

export function GroupList({ instanceId }: GroupListProps): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [pendingDialog, setPendingDialog] = React.useState<PendingDialog>(null);

  const query = useGroupList(instanceId);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const pages = query.data?.pages ?? [];
  const groups = pages.flatMap((page) => page.items);
  const firstPage = pages[0];

  const actions = useGroupListActions(instanceId, (groupId) =>
    setPendingDialog({ kind: 'enable', groupId }),
  );
  const {
    busy,
    enableErrorMessage,
    syncRequestedAt,
    sawRateLimitedError,
    onSyncClick,
    onToggleSend,
    confirmEnable,
    confirmLeave,
    clearEnableError,
  } = actions;

  const nextSyncAfter = firstPage?.sync.nextSyncAfter ?? null;
  const syncIsRateLimited =
    sawRateLimitedError ||
    (nextSyncAfter !== null && new Date(nextSyncAfter).getTime() > Date.now());

  const onConfirmEnable = (groupId: string): void => {
    void confirmEnable(groupId).then((succeeded) => {
      if (succeeded) setPendingDialog(null);
    });
  };

  const onConfirmLeave = (groupId: string): void => {
    void confirmLeave(groupId).then((succeeded) => {
      if (succeeded) setPendingDialog(null);
    });
  };

  const activeGroup = pendingDialog
    ? groups.find((group) => group.id === pendingDialog.groupId)
    : undefined;

  return (
    <div data-testid="groups-screen" className="flex flex-col gap-6">
      <PageHeader title={t('groups.title')} description={t('groups.subtitle')} />

      <Alert tone="neutral" title={t('groups.disclosure')} data-testid="group-header-disclosure" />

      <div className="flex items-center gap-3">
        <Button
          type="button"
          data-testid="groups-sync-button"
          disabled={syncIsRateLimited}
          onClick={onSyncClick}
        >
          {t('groups.list.syncNow')}
        </Button>
        {syncIsRateLimited && nextSyncAfter ? (
          <p data-testid="groups-sync-rate-limited" className="text-sm font-ui text-muted">
            {t('groups.list.syncRateLimited', {
              time: dateFormatter.format(new Date(nextSyncAfter)),
            })}
          </p>
        ) : null}
        {syncRequestedAt ? (
          <p data-testid="groups-sync-requested" className="text-sm font-ui text-muted">
            {t('groups.list.syncRequested')}
          </p>
        ) : null}
        <p className="text-sm font-ui text-muted">
          {firstPage?.sync.lastSyncedAt
            ? t('groups.list.lastSynced', {
                time: dateFormatter.format(new Date(firstPage.sync.lastSyncedAt)),
              })
            : t('groups.list.neverSynced')}
        </p>
      </div>

      {firstPage ? (
        <div className="flex flex-wrap items-center gap-4">
          <GroupCapChip
            effGroupDailyCap={firstPage.groupCap.effGroupDailyCap}
            sentToday={firstPage.groupCap.sentToday}
            remainingToday={firstPage.groupCap.remainingToday}
          />
          <DeviceBudgetLine
            total={firstPage.budget.trackedDevicesEnabledTotal}
            max={firstPage.budget.max}
          />
        </div>
      ) : null}

      {query.isLoading ? (
        <div data-testid="groups-loading">
          <SkeletonRows rows={4} columns={4} />
        </div>
      ) : null}

      {query.isError ? (
        <div data-testid="groups-error">
          <ErrorState
            title={t('broadcasts.composer.error.generic')}
            retryAction={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {t('common.retry')}
              </Button>
            }
          />
        </div>
      ) : null}

      {!query.isLoading && !query.isError && groups.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden size={20} />}
          title={t('groups.title')}
          body={t('groups.list.empty')}
        />
      ) : null}

      {!query.isLoading && !query.isError && groups.length > 0 ? (
        <>
          <Table caption={t('groups.title')}>
            <THead>
              <TR>
                <TH>{t('groups.column.subject')}</TH>
                <TH>{t('groups.column.participants')}</TH>
                <TH>{t('groups.column.role')}</TH>
                <TH>{t('groups.column.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {groups.map((group) => (
                <GroupRow
                  key={group.id}
                  group={group}
                  busy={busy}
                  onToggleSend={(nextEnabled) => onToggleSend(group.id, nextEnabled)}
                  onLeave={() => setPendingDialog({ kind: 'leave', groupId: group.id })}
                />
              ))}
            </TBody>
          </Table>

          {query.hasNextPage ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="groups-load-more"
              loading={query.isFetchingNextPage}
              loadingLabel={t('common.loading')}
              onClick={() => void query.fetchNextPage()}
            >
              {t('broadcasts.list.loadMore')}
            </Button>
          ) : null}
        </>
      ) : null}

      <p data-testid="groups-optout-warning" className="text-sm font-ui text-muted">
        {t('groups.optout.unattributableWarning')}
      </p>

      {pendingDialog?.kind === 'enable' ? (
        <EnableSendDialog
          participantCount={activeGroup?.participantCount ?? null}
          budgetTotal={firstPage?.budget.trackedDevicesEnabledTotal ?? 0}
          budgetMax={firstPage?.budget.max ?? 0}
          busy={busy}
          errorMessage={enableErrorMessage}
          onConfirm={() => onConfirmEnable(pendingDialog.groupId)}
          onCancel={() => {
            setPendingDialog(null);
            clearEnableError();
          }}
        />
      ) : null}

      {pendingDialog?.kind === 'leave' ? (
        <LeaveDialog
          busy={busy}
          onConfirm={() => onConfirmLeave(pendingDialog.groupId)}
          onCancel={() => setPendingDialog(null)}
        />
      ) : null}
    </div>
  );
}
