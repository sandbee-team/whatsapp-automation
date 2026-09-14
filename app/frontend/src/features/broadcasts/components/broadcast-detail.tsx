import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Skeleton,
  useLocale,
  useT,
  useToast,
} from '@wp/ui';
import { isTerminalCampaignStatus } from '@wp/domain';
import { PageHeader } from '../../../components/page-header.js';
import { useBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast } from '../api.js';
import { broadcastKeys } from '../keys.js';
import { fetchInstanceCard } from '../../instances/api.js';
import { instanceKeys } from '../../instances/keys.js';
import { ApiError } from '../../../lib/api-client.js';
import { Funnel } from './funnel.js';
import { ConfirmAction } from './confirm-action.js';

/**
 * BroadcastDetail (P23a U5; P26b U4 restyle; P26b C1 fix round CRITICAL-1) -
 * the `/broadcasts/$id` screen: header, `Funnel`, a draft/scheduled note, and
 * the Pause/Resume/Cancel actions (each gated behind `ConfirmAction` - core
 * invariant: no destructive/state-changing action fires on a single click).
 * `refetchInterval` of 10s while non-terminal is the SSE fallback only.
 *
 * A failed pause/resume/cancel is surfaced with `role="alert"` and the
 * confirm dialog STAYS OPEN so the user can retry or back out - never
 * silently swallowed. See `actionKeyRef` below for the retry-safe
 * Idempotency-Key this implies. The instance label is resolved via
 * `fetchInstanceCard` rather than showing the raw instance uuid; it falls
 * back to the id while loading or on error.
 */
export interface BroadcastDetailProps {
  id: string;
}

type PendingAction = 'pause' | 'resume' | 'cancel' | null;

function actionErrorKeyFor(
  error: unknown,
): 'broadcasts.composer.error.conflict' | 'broadcasts.composer.error.generic' {
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    return 'broadcasts.composer.error.conflict';
  }
  return 'broadcasts.composer.error.generic';
}

export function BroadcastDetail({ id }: BroadcastDetailProps): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionErrorKey, setActionErrorKey] = React.useState<
    'broadcasts.composer.error.conflict' | 'broadcasts.composer.error.generic' | null
  >(null);
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  // ONE Idempotency-Key per action INTENT, reused on every retry of that
  // same intent (the confirm dialog deliberately stays open on failure so
  // the user can retry) - same idiom as `useComposer.ts#onSend`'s
  // `submissionRef`. Cleared on success or a definitively terminal 4xx
  // ApiError; kept on a 5xx/transport failure so the retry reuses it.
  const actionKeyRef = React.useRef<Partial<Record<'pause' | 'resume' | 'cancel', string>>>({});

  const {
    data: detail,
    isLoading,
    isError,
    error,
  } = useBroadcast(id, {
    refetchIntervalMs: 10_000,
  });

  const instanceCard = useQuery({
    queryKey: instanceKeys.card(detail?.instanceId ?? ''),
    queryFn: () => fetchInstanceCard(detail?.instanceId ?? ''),
    enabled: Boolean(detail?.instanceId),
  });
  const instanceLabel = instanceCard.data?.label ?? detail?.instanceId ?? '';

  const isNotFound =
    isError && error !== null && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code === 'NOT_FOUND'
      : false;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: broadcastKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: broadcastKeys.list() });
  };

  const runAction = (action: 'pause' | 'resume' | 'cancel'): void => {
    setBusy(true);
    setActionErrorKey(null);
    actionKeyRef.current[action] ??= crypto.randomUUID();
    const key = actionKeyRef.current[action]!;
    const request =
      action === 'pause'
        ? pauseBroadcast(id, key)
        : action === 'resume'
          ? resumeBroadcast(id, key)
          : cancelBroadcast(id, key, 'user_requested');

    void request
      .then(() => {
        delete actionKeyRef.current[action];
        invalidate();
        setPendingAction(null);
        showToast({
          tone: 'success',
          title: t(
            action === 'pause'
              ? 'broadcasts.list.toast.pauseSuccess'
              : action === 'resume'
                ? 'broadcasts.list.toast.resumeSuccess'
                : 'broadcasts.list.toast.cancelSuccess',
          ),
        });
      })
      .catch((actionError: unknown) => {
        // A definitively terminal 4xx clears the key so a corrected retry
        // mints its own; a 5xx/transport failure keeps it so the user's
        // retry click (dialog stays open) reuses the same key - never two
        // real actions from one intent.
        if (
          actionError instanceof ApiError &&
          actionError.status >= 400 &&
          actionError.status < 500
        ) {
          delete actionKeyRef.current[action];
        }
        setActionErrorKey(actionErrorKeyFor(actionError));
      })
      .finally(() => setBusy(false));
  };

  if (isLoading) {
    return (
      <div data-testid="broadcast-detail-loading" className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isNotFound || !detail) {
    return (
      <EmptyState title={t('broadcasts.detail.notFound')} body={t('broadcasts.detail.notFound')} />
    );
  }

  const showPause = detail.status === 'running' || detail.status === 'expanding';
  const showResume = detail.status === 'paused';
  const showCancel = !isTerminalCampaignStatus(detail.status);
  const isDraftOrScheduled = detail.status === 'draft' || detail.status === 'scheduled';

  return (
    <div data-testid="broadcast-detail-screen" className="flex flex-col gap-6">
      <PageHeader
        title={detail.name}
        breadcrumbs={[{ label: t('broadcasts.detail.back'), to: '/broadcasts' }]}
        actions={<Badge tone="info">{t(`broadcasts.status.${detail.status}`)}</Badge>}
      />

      <Card>
        <CardBody className="flex flex-col gap-1">
          <p className="text-sm font-ui text-muted">
            {t('broadcasts.detail.sendingFrom', { label: instanceLabel })}
          </p>
          {detail.scheduledAt ? (
            <p className="text-sm font-ui text-muted">
              {t('broadcasts.detail.scheduledFor', {
                date: dateFormatter.format(new Date(detail.scheduledAt)),
              })}
            </p>
          ) : null}
          <p className="text-sm font-ui text-muted">
            {t('broadcasts.detail.createdAt', {
              date: dateFormatter.format(new Date(detail.createdAt)),
            })}
          </p>
        </CardBody>
      </Card>

      <Funnel detail={detail} />

      {isDraftOrScheduled ? (
        <p>
          {t('broadcasts.detail.draftNote')}{' '}
          <Link to="/broadcasts/new">{t('broadcasts.list.new')}</Link>
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {showPause ? (
          <Button type="button" onClick={() => setPendingAction('pause')} disabled={busy}>
            {t('broadcasts.detail.pause')}
          </Button>
        ) : null}
        {showResume ? (
          <Button type="button" onClick={() => setPendingAction('resume')} disabled={busy}>
            {t('broadcasts.detail.resume')}
          </Button>
        ) : null}
        {showCancel ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPendingAction('cancel')}
            disabled={busy}
          >
            {t('broadcasts.detail.cancel')}
          </Button>
        ) : null}
      </div>

      {pendingAction === 'pause' ? (
        <ConfirmAction
          message={
            <>
              <p>{t('broadcasts.detail.pauseConfirm')}</p>
              {actionErrorKey ? (
                <p role="alert" className="text-sm font-ui text-danger">
                  {t(actionErrorKey)}
                </p>
              ) : null}
            </>
          }
          confirmLabel={t('broadcasts.detail.confirm')}
          cancelLabel={t('broadcasts.detail.back')}
          onConfirm={() => runAction('pause')}
          onCancel={() => {
            setPendingAction(null);
            setActionErrorKey(null);
          }}
          busy={busy}
        />
      ) : null}
      {pendingAction === 'resume' ? (
        <ConfirmAction
          message={
            <>
              <p>{t('broadcasts.detail.resumeConfirm')}</p>
              {actionErrorKey ? (
                <p role="alert" className="text-sm font-ui text-danger">
                  {t(actionErrorKey)}
                </p>
              ) : null}
            </>
          }
          confirmLabel={t('broadcasts.detail.confirm')}
          cancelLabel={t('broadcasts.detail.back')}
          onConfirm={() => runAction('resume')}
          onCancel={() => {
            setPendingAction(null);
            setActionErrorKey(null);
          }}
          busy={busy}
        />
      ) : null}
      {pendingAction === 'cancel' ? (
        <ConfirmAction
          message={
            <>
              <p>{t('broadcasts.cancel.notRecalled')}</p>
              <p>{t('broadcasts.cancel.confirmBody')}</p>
              {actionErrorKey ? (
                <p role="alert" className="text-sm font-ui text-danger">
                  {t(actionErrorKey)}
                </p>
              ) : null}
            </>
          }
          confirmLabel={t('broadcasts.detail.confirm')}
          cancelLabel={t('broadcasts.detail.back')}
          onConfirm={() => runAction('cancel')}
          onCancel={() => {
            setPendingAction(null);
            setActionErrorKey(null);
          }}
          busy={busy}
        />
      ) : null}

      <p data-testid="broadcast-disclosure">{t('broadcasts.disclosure')}</p>
    </div>
  );
}
