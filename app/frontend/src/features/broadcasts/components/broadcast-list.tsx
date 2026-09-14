import * as React from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertDialog, Button, DataTable, EmptyState, ErrorState, useT, useToast } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { ApiError } from '../../../lib/api-client.js';
import {
  cancelBroadcast,
  listBroadcasts,
  pauseBroadcast,
  resumeBroadcast,
  type BroadcastSummary,
} from '../api.js';
import { broadcastKeys } from '../keys.js';
import { useBroadcastListColumns } from './broadcast-list-columns.js';

/**
 * BroadcastList (P23a Unit U5; P26b U4 restyle) - the `/broadcasts` screen: a
 * keyset-paginated `DataTable` ("Load more" driven by `meta.nextCursor`,
 * never a page number - same idiom as `features/contacts/ContactsList.tsx`),
 * a "New broadcast" action in the `PageHeader`, and the mandatory disclosure
 * paragraph at the bottom (every list AND detail surface ships it - core
 * invariant 6). Honest loading/empty/error states.
 *
 * Pages are owned by `useInfiniteQuery` under the SAME `broadcastKeys.list()`
 * key every other page uses (`queryKey: broadcastKeys.list()`, per-page
 * identity carried by `pageParam`, never appended to the key) - a refetch
 * REPLACES `data.pages`, it never appends to a parallel `React.useState`
 * accumulator (see the P23a C1 fix round doc this file used to carry).
 *
 * Row actions (pause/resume/cancel) are gated behind an `AlertDialog`
 * confirm and always end in a toast (success or failure) - never a silent
 * mutation. The list summary contract (`BroadcastSummary`) carries no
 * per-row sent/total counters, so this table shows status + audience + quote
 * only; the funnel/progress bar lives on the detail screen where those
 * counters exist.
 */
export function BroadcastList(): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [pendingAction, setPendingAction] = React.useState<{
    broadcast: BroadcastSummary;
    action: 'pause' | 'resume' | 'cancel';
  } | null>(null);
  const [busy, setBusy] = React.useState(false);

  // ONE Idempotency-Key per (broadcast, action) INTENT, reused on every
  // retry of that same intent (the confirm dialog stays open on failure) -
  // same idiom as `broadcast-detail.tsx`'s `actionKeyRef`. Cleared on
  // success or a definitively terminal 4xx; kept on a 5xx/transport failure.
  const actionKeysRef = React.useRef<Map<string, string>>(new Map());

  const { data, isLoading, isError, isFetchingNextPage, fetchNextPage, hasNextPage } =
    useInfiniteQuery({
      queryKey: broadcastKeys.list(),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) => listBroadcasts(pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const broadcasts = data?.pages.flatMap((page) => page.items) ?? [];

  const runAction = (): void => {
    if (!pendingAction) return;
    const { broadcast, action } = pendingAction;
    setBusy(true);
    const actionMapKey = `${broadcast.id}:${action}`;
    const existingKey = actionKeysRef.current.get(actionMapKey);
    const key = existingKey ?? crypto.randomUUID();
    actionKeysRef.current.set(actionMapKey, key);
    const request =
      action === 'pause'
        ? pauseBroadcast(broadcast.id, key)
        : action === 'resume'
          ? resumeBroadcast(broadcast.id, key)
          : cancelBroadcast(broadcast.id, key, 'user_requested');

    void request
      .then(() => {
        actionKeysRef.current.delete(actionMapKey);
        void queryClient.invalidateQueries({ queryKey: broadcastKeys.list() });
        showToast({ tone: 'success', title: t(`broadcasts.list.toast.${action}Success`) });
        setPendingAction(null);
      })
      .catch((actionError: unknown) => {
        // A definitively terminal 4xx clears the key so a corrected retry
        // mints its own; a 5xx/transport failure keeps it so the retry
        // reuses the same key - never two real actions from one intent.
        if (
          actionError instanceof ApiError &&
          actionError.status >= 400 &&
          actionError.status < 500
        ) {
          actionKeysRef.current.delete(actionMapKey);
        }
        showToast({ tone: 'danger', title: t('broadcasts.list.toast.actionError') });
      })
      .finally(() => setBusy(false));
  };

  const columns = useBroadcastListColumns(t, setPendingAction);

  return (
    <div data-testid="broadcasts-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('broadcasts.list.title')}
        actions={
          <Link to="/broadcasts/new">
            <Button type="button" data-testid="broadcasts-new-button">
              {t('broadcasts.list.new')}
            </Button>
          </Link>
        }
      />

      {isLoading ? <p data-testid="broadcasts-loading" className="sr-only" /> : null}
      {isError ? <p data-testid="broadcasts-error" className="sr-only" /> : null}

      <DataTable
        columns={columns}
        data={broadcasts}
        caption={t('broadcasts.list.title')}
        isLoading={isLoading}
        getRowId={(row) => row.id}
        errorState={
          isError ? (
            <ErrorState title={t('broadcasts.composer.error.generic')} role="alert" />
          ) : undefined
        }
        emptyState={
          <EmptyState
            title={t('broadcasts.list.title')}
            body={t('broadcasts.list.empty')}
            action={
              <Link to="/broadcasts/new">
                <Button type="button">{t('broadcasts.list.new')}</Button>
              </Link>
            }
          />
        }
      />

      {!isLoading && !isError && hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="secondary"
            data-testid="broadcasts-load-more"
            loading={isFetchingNextPage}
            loadingLabel={t('common.loading')}
            onClick={() => void fetchNextPage()}
          >
            {t('broadcasts.list.loadMore')}
          </Button>
        </div>
      ) : null}

      <p data-testid="broadcast-disclosure">{t('broadcasts.disclosure')}</p>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={t('broadcasts.detail.confirm')}
        body={
          pendingAction
            ? t(
                pendingAction.action === 'pause'
                  ? 'broadcasts.detail.pauseConfirm'
                  : pendingAction.action === 'resume'
                    ? 'broadcasts.detail.resumeConfirm'
                    : 'broadcasts.cancel.confirmBody',
              )
            : ''
        }
        confirmLabel={t('broadcasts.detail.confirm')}
        cancelLabel={t('broadcasts.detail.back')}
        destructive={pendingAction?.action === 'cancel'}
        loading={busy}
        onConfirm={runAction}
      />
    </div>
  );
}
