import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setClientPlanInputSchema, type SetClientPlanInput } from '@wp/contracts';
import type { MessageKey } from '@wp/i18n';
import { Button, Select, useT, useToast } from '@wp/ui';
import { uuidv7 } from '@wp/utils';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { ApiError } from '../../../lib/api-client.js';
import { reactivateClient, setClientPlan, suspendClient } from '../api.js';
import { clientKeys } from '../keys.js';

/**
 * client-header-actions.tsx (P28 Unit U6, step 9) - Suspend (destructive
 * `StaffActionDialog`, "queued messages preserved" copy in the body) /
 * Reactivate / Change plan, each gated by `canDo`.
 */
export interface ClientHeaderActionsProps {
  clientId: string;
  status: string;
}

/**
 * The plan keys the internal route actually accepts, read FROM the contract
 * (`setClientPlanInputSchema`) rather than retyped here, paired with their
 * label keys. The `satisfies` clause is load-bearing: adding a plan to the
 * contract enum without a label here is a COMPILE error, so the picker can
 * never silently omit a plan the route would accept.
 */
type PlanKey = SetClientPlanInput['planKey'];

const PLAN_LABEL_KEYS = {
  starter: 'admin.clientDetail.changePlan.plan.starter',
  growth: 'admin.clientDetail.changePlan.plan.growth',
  business: 'admin.clientDetail.changePlan.plan.business',
} as const satisfies Record<PlanKey, MessageKey>;

const PLAN_KEY_OPTIONS = setClientPlanInputSchema.shape.planKey.options;

export function ClientHeaderActions({
  clientId,
  status,
}: ClientHeaderActionsProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [suspendOpen, setSuspendOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [planKey, setPlanKey] = React.useState<PlanKey | ''>('');

  const canSuspend = canDo('clients.suspend');
  const canReactivate = canDo('clients.reactivate');
  const canChangePlan = canDo('clients.plan');
  const isActive = status === 'active';

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) }).then(() => undefined);

  const onReactivate = async (): Promise<void> => {
    try {
      await reactivateClient(clientId, 'reactivated from client detail', uuidv7());
      showToast({ title: t('admin.common.successGeneric'), tone: 'success' });
      await refresh();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('admin.common.errorGeneric');
      showToast({ title: message, tone: 'danger' });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {isActive ? (
        <Button
          variant="danger"
          data-testid="client-detail-suspend"
          disabled={!canSuspend}
          title={canSuspend ? undefined : t('admin.roleTooltip.disabled')}
          onClick={() => setSuspendOpen(true)}
        >
          {t('admin.clientDetail.suspend.button')}
        </Button>
      ) : (
        <Button
          data-testid="client-detail-reactivate"
          disabled={!canReactivate}
          title={canReactivate ? undefined : t('admin.roleTooltip.disabled')}
          onClick={() => void onReactivate()}
        >
          {t('admin.clientDetail.reactivate.button')}
        </Button>
      )}
      <Button
        variant="outline"
        data-testid="client-detail-change-plan"
        disabled={!canChangePlan}
        title={canChangePlan ? undefined : t('admin.roleTooltip.disabled')}
        onClick={() => setPlanOpen(true)}
      >
        {t('admin.clientDetail.changePlan.button')}
      </Button>

      <StaffActionDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={t('admin.clientDetail.suspend.title')}
        context={t('admin.clientDetail.suspend.body')}
        destructive
        submitLabel={t('admin.clientDetail.suspend.button')}
        successMessage={t('admin.common.successGeneric')}
        onSubmit={async (reason, idempotencyKey) => {
          await suspendClient(clientId, reason, idempotencyKey);
          await refresh();
        }}
      />

      <StaffActionDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        title={t('admin.clientDetail.changePlan.title')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={planKey !== ''}
        extraFields={
          <Select
            label={t('admin.clientDetail.changePlan.planLabel')}
            placeholder={t('admin.clientDetail.changePlan.planPlaceholder')}
            value={planKey === '' ? null : planKey}
            onValueChange={(value) => setPlanKey(value as PlanKey)}
            options={PLAN_KEY_OPTIONS.map((value) => ({
              value,
              label: t(PLAN_LABEL_KEYS[value]),
            }))}
          />
        }
        onSubmit={async (reason, idempotencyKey) => {
          await setClientPlan(clientId, planKey, reason, idempotencyKey);
          await refresh();
        }}
      />
    </div>
  );
}
