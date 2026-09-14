import { Badge, Button, Switch, TD, TR, useT } from '@wp/ui';
import type { TFunction } from '@wp/ui';
import type { GroupSummary } from '../api.js';

type MessageKey = Parameters<TFunction>[0];

/**
 * GroupRow (P24 groups-messaging, Unit U5) - one group list row: subject
 * (fallback `groups.subject.fallback`), member count, role, a status pill,
 * the per-group reason line (`eligibility.reason` when not sendable, else
 * `disabledReason` when set), the send toggle (opening the caller's enable
 * dialog only when turning ON - turning OFF is immediate, no confirm), and a
 * Leave action hidden once `leaveRequestedAt` is set (replaced by the
 * `leave_requested` reason line instead). Never renders a group JID - the
 * contract carries none (data-minimisation, see `@wp/contracts`'s own doc
 * comment on `groupSummarySchema`).
 */
export interface GroupRowProps {
  group: GroupSummary;
  busy: boolean;
  onToggleSend: (nextEnabled: boolean) => void;
  onLeave: () => void;
}

const KNOWN_DISABLED_REASON_KEYS: Record<string, MessageKey> = {
  group_forbidden: 'groups.reason.group_forbidden',
  leave_requested: 'groups.reason.leave_requested',
  not_participant: 'groups.reason.not_participant',
};

function disabledReasonKey(reason: string): MessageKey {
  return KNOWN_DISABLED_REASON_KEYS[reason] ?? 'groups.reason.generic';
}

export function GroupRow({ group, busy, onToggleSend, onLeave }: GroupRowProps): React.JSX.Element {
  const t = useT();

  const hasLeft = group.leaveRequestedAt !== null;
  const reasonKey: MessageKey | null = !group.eligibility.sendable
    ? (`groups.reason.${group.eligibility.reason}` as MessageKey)
    : group.disabledReason
      ? disabledReasonKey(group.disabledReason)
      : null;

  return (
    <TR data-testid={`group-row-${group.id}`}>
      <TD>{group.subject ?? t('groups.subject.fallback')}</TD>
      <TD>{`~${String(group.participantCount ?? 0)}`}</TD>
      <TD>{group.ourRole ? t(`groups.role.${group.ourRole}`) : '—'}</TD>
      <TD>
        <div className="flex flex-col gap-1">
          <Badge tone={group.sendEnabled ? 'success' : 'neutral'}>
            {t(group.sendEnabled ? 'groups.status.enabled' : 'groups.status.disabled')}
          </Badge>
          {reasonKey ? (
            <span
              data-testid={`group-row-reason-${group.id}`}
              className="text-sm font-ui text-muted"
            >
              {t(reasonKey, { total: group.trackedParticipantDevices })}
            </span>
          ) : null}
        </div>
      </TD>
      <TD>
        <div className="flex items-center gap-2">
          <Switch
            label={t('groups.column.status')}
            size="sm"
            data-testid={`group-row-toggle-${group.id}`}
            checked={group.sendEnabled}
            disabled={busy}
            onCheckedChange={(checked) => onToggleSend(checked)}
          />
          {!hasLeft ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onLeave}
              data-testid={`group-row-leave-${group.id}`}
            >
              {t('groups.leave.confirm')}
            </Button>
          ) : null}
        </div>
      </TD>
    </TR>
  );
}
