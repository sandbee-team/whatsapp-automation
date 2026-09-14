import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, DateTimePicker, Input, useT } from '@wp/ui';
import type { AdminInstanceItem } from '../../instances/api.js';
import { pauseInstance, pacingOverride, resumeInstance } from '../../instances/api.js';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { clientKeys } from '../keys.js';

/**
 * instance-row-actions.tsx (P28 Unit U6, step 9) - Pause / Resume / Relax
 * pacing for one instance row on the client-detail Instances tab. Resume
 * shows the acknowledgement checkbox + honest copy when
 * `pauseReason === 'provider_restriction'`; Relax pacing is disabled while
 * under that same pause (design brief section 2, R-shaped requirement).
 */
export interface InstanceRowActionsProps {
  clientId: string;
  instance: AdminInstanceItem;
}

const PACING_FIELDS = [
  'dailyCap',
  'hourlyCap',
  'newConvCap',
  'gapMinMs',
  'gapMaxMs',
  'groupDailyCap',
] as const;

export function InstanceRowActions({
  clientId,
  instance,
}: InstanceRowActionsProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const queryClient = useQueryClient();
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [resumeOpen, setResumeOpen] = React.useState(false);
  const [relaxOpen, setRelaxOpen] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const [patch, setPatch] = React.useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = React.useState<string | null>(null);

  const isProviderRestriction = instance.pauseReason === 'provider_restriction';
  const canPause = canDo('instances.pause');
  const canResumeRole = canDo('instances.resume');
  const canRelax = canDo('pacing.relax') && !isProviderRestriction;

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) }).then(() => undefined);

  const patchValues = React.useMemo(() => {
    const result: Record<string, number> = {};
    for (const field of PACING_FIELDS) {
      const raw = patch[field];
      if (raw !== undefined && raw.trim() !== '') result[field] = Number(raw);
    }
    return result;
  }, [patch]);

  const patchValid = PACING_FIELDS.every((field) => {
    const raw = patch[field];
    return raw === undefined || raw.trim() === '' || /^\d+$/.test(raw);
  });

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        data-testid={`instance-pause-${instance.id}`}
        disabled={!canPause}
        title={canPause ? undefined : t('admin.roleTooltip.disabled')}
        onClick={() => setPauseOpen(true)}
      >
        {t('admin.clientDetail.instances.pause.button')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid={`instance-resume-${instance.id}`}
        disabled={!canResumeRole}
        title={canResumeRole ? undefined : t('admin.roleTooltip.disabled')}
        onClick={() => setResumeOpen(true)}
      >
        {t('admin.clientDetail.instances.resume.button')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid={`instance-relax-${instance.id}`}
        disabled={!canRelax}
        title={
          canDo('pacing.relax') && isProviderRestriction
            ? t('admin.clientDetail.instances.relaxPacing.disabledProviderRestriction', {
                reason: instance.pauseReason ?? '',
              })
            : canDo('pacing.relax')
              ? undefined
              : t('admin.roleTooltip.disabled')
        }
        onClick={() => setRelaxOpen(true)}
      >
        {t('admin.clientDetail.instances.relaxPacing.button')}
      </Button>

      <StaffActionDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={t('admin.clientDetail.instances.pause.title')}
        successMessage={t('admin.common.successGeneric')}
        onSubmit={async (reason, idempotencyKey) => {
          await pauseInstance(instance.id, reason, idempotencyKey);
          await refresh();
        }}
      />

      <StaffActionDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        title={t('admin.clientDetail.instances.resume.title')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={!isProviderRestriction || ack}
        extraFields={
          isProviderRestriction ? (
            <Checkbox
              data-testid={`instance-resume-ack-${instance.id}`}
              label={t('admin.clientDetail.instances.resume.providerRestrictionAck')}
              checked={ack}
              onCheckedChange={(checked) => setAck(checked === true)}
            />
          ) : undefined
        }
        onSubmit={async (reason, idempotencyKey) => {
          await resumeInstance(instance.id, reason, idempotencyKey);
          await refresh();
        }}
      />

      <StaffActionDialog
        open={relaxOpen}
        onOpenChange={setRelaxOpen}
        title={t('admin.clientDetail.instances.relaxPacing.title')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={patchValid && expiresAt !== null}
        extraFields={
          <div className="flex flex-col gap-3">
            {PACING_FIELDS.map((field) => (
              <Input
                key={field}
                label={t(`admin.clientDetail.instances.relaxPacing.${field}`)}
                data-testid={`instance-relax-${field}-${instance.id}`}
                value={patch[field] ?? ''}
                onChange={(event) =>
                  setPatch((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            ))}
            <DateTimePicker
              label={t('admin.clientDetail.instances.relaxPacing.expiry')}
              value={expiresAt}
              onValueChange={setExpiresAt}
            />
          </div>
        }
        onSubmit={async (reason, idempotencyKey) => {
          if (!expiresAt) return;
          await pacingOverride(instance.id, patchValues, expiresAt, reason, idempotencyKey);
          await refresh();
        }}
      />
    </div>
  );
}
