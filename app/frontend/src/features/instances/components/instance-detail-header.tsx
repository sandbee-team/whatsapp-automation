import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AlertDialog, Badge, Button, StatusDot, useT, useToast } from '@wp/ui';
import {
  deleteInstance,
  isNoFreeSlotError,
  online,
  park,
  type InstanceCardResult,
} from '../api.js';

/**
 * InstanceDetailHeader (P26b U3; delete added 2026-09-15) - status chips
 * (link state / health band / warm-up tier-day) plus the
 * Pause/Resume/Reconnect/Why/Delete action row, rendered into the detail
 * page's `PageHeader` `actions` slot. Pause, Resume and Delete all confirm
 * via `AlertDialog` (never a bare click - a fail-safe action) then toast
 * success/failure; Pause/Resume invalidate the card query (`onMutated`) so
 * the page reflects the new state without a full reload, while Delete
 * navigates back to `/instances` on success - the card this page reads no
 * longer exists once soft-deleted (`GET .../card` would 404), so unlike
 * Pause/Resume there is no "same page, new state" to refetch into. A
 * `NO_FREE_SLOT` 409 on Resume surfaces the same honest message the Connect
 * flow already uses, never a generic error. Reconnect has no
 * existing-instance re-entry into `useConnectFlow` today, so it links back
 * to the numbers screen (spec's own fallback) rather than fabricating one.
 *
 * Delete is only OFFERED (not merely disabled) while `data.linkState !==
 * 'linked'` - matching the backend's own `INVALID_STATE` guard in
 * `instances.routes.ts`'s `DELETE /v1/instances/:id` handler exactly, so a
 * user can never reach a click that the server would just refuse.
 */
export interface InstanceDetailHeaderProps {
  instanceId: string;
  data: InstanceCardResult;
  onOpenWhyDrawer: () => void;
  onMutated: () => void;
}

export function InstanceDetailHeader({
  instanceId,
  data,
  onOpenWhyDrawer,
  onMutated,
}: InstanceDetailHeaderProps): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [confirmAction, setConfirmAction] = React.useState<'pause' | 'resume' | 'delete' | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const isOnline = !data.parked;
  const canDelete = data.linkState !== 'linked';

  const runPause = async (): Promise<void> => {
    setIsSubmitting(true);
    try {
      await park(instanceId);
      showToast({ title: t('instances.detail.pauseSuccess'), tone: 'success' });
      onMutated();
    } catch {
      showToast({ title: t('instances.detail.pauseError'), tone: 'danger' });
    } finally {
      setIsSubmitting(false);
      setConfirmAction(null);
    }
  };

  const runResume = async (): Promise<void> => {
    setIsSubmitting(true);
    try {
      await online(instanceId);
      showToast({ title: t('instances.detail.resumeSuccess'), tone: 'success' });
      onMutated();
    } catch (error) {
      const message = isNoFreeSlotError(error)
        ? t('instances.connect.noFreeSlot.body')
        : t('instances.detail.resumeError');
      showToast({ title: message, tone: 'danger' });
    } finally {
      setIsSubmitting(false);
      setConfirmAction(null);
    }
  };

  const runDelete = async (): Promise<void> => {
    setIsSubmitting(true);
    try {
      await deleteInstance(instanceId);
      showToast({ title: t('instances.detail.deleteSuccess'), tone: 'success' });
      // Unlike Pause/Resume (onMutated -> refetch the SAME card), the card
      // this page reads no longer exists once soft-deleted - navigate back
      // to the numbers list rather than invalidating a query whose next
      // fetch would just 404.
      void navigate({ to: '/instances' });
    } catch {
      showToast({ title: t('instances.detail.deleteError'), tone: 'danger' });
      setIsSubmitting(false);
      setConfirmAction(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusDot
        data-testid="instance-detail-status-dot"
        tone={data.healthState === 'connected' ? 'success' : 'danger'}
        label={data.linkState}
        hideLabel={false}
      />
      <Badge tone={data.healthBand === 'HEALTHY' ? 'success' : 'warning'}>
        {t('instances.card.health', { score: data.healthScore ?? 0, band: data.healthBand })}
      </Badge>
      <Badge tone="neutral">
        {t('instances.card.safeModeStatus', {
          profile: t('instances.card.pacingProfileName'),
          tier: data.warmupTier,
          day: data.warmupDay,
        })}
      </Badge>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="instance-detail-why-button"
        onClick={onOpenWhyDrawer}
      >
        {t('instances.detail.why')}
      </Button>

      {isOnline ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="instance-detail-pause-button"
          onClick={() => setConfirmAction('pause')}
        >
          {t('instances.detail.pause')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="instance-detail-resume-button"
          onClick={() => setConfirmAction('resume')}
        >
          {t('instances.detail.resume')}
        </Button>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="instance-detail-reconnect-button"
        onClick={() => void navigate({ to: '/instances' })}
      >
        {t('instances.detail.reconnect')}
      </Button>

      {canDelete ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="instance-detail-delete-button"
          onClick={() => setConfirmAction('delete')}
        >
          {t('instances.detail.delete')}
        </Button>
      ) : null}

      <AlertDialog
        open={confirmAction === 'pause'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('instances.detail.pauseConfirmTitle')}
        body={t('instances.detail.pauseConfirmBody')}
        confirmLabel={t('instances.detail.pause')}
        cancelLabel={t('common.close')}
        destructive
        loading={isSubmitting}
        onConfirm={() => void runPause()}
      />
      <AlertDialog
        open={confirmAction === 'resume'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('instances.detail.resumeConfirmTitle')}
        body={t('instances.detail.resumeConfirmBody')}
        confirmLabel={t('instances.detail.resume')}
        cancelLabel={t('common.close')}
        loading={isSubmitting}
        onConfirm={() => void runResume()}
      />
      <AlertDialog
        open={confirmAction === 'delete'}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('instances.detail.deleteConfirmTitle')}
        body={t('instances.detail.deleteConfirmBody')}
        confirmLabel={t('instances.detail.delete')}
        cancelLabel={t('common.close')}
        destructive
        loading={isSubmitting}
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}
