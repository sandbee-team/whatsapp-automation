import { Badge, useT } from '@wp/ui';

/**
 * GroupCapChip (P24 groups-messaging, Unit U5) - the group daily-cap chip:
 * `groups.cap.today`/`groups.cap.remaining` normally, or `groups.cap.
 * offAtTier` when `effGroupDailyCap` is 0 - NEVER "0 of 0" (the phase's
 * explicit honesty requirement: a zero cap is a warm-up-tier state, not an
 * empty count).
 */
export interface GroupCapChipProps {
  effGroupDailyCap: number;
  sentToday: number;
  remainingToday: number;
}

export function GroupCapChip({
  effGroupDailyCap,
  sentToday,
  remainingToday,
}: GroupCapChipProps): React.JSX.Element {
  const t = useT();

  if (effGroupDailyCap === 0) {
    return (
      <Badge tone="warning" data-testid="group-cap-chip">
        {t('groups.cap.offAtTier')}
      </Badge>
    );
  }

  return (
    <div data-testid="group-cap-chip" className="flex flex-col gap-1">
      <span className="text-sm font-ui text-fg">
        {t('groups.cap.today', { sent: sentToday, cap: effGroupDailyCap })}
      </span>
      <span className="text-sm font-ui text-muted">
        {t('groups.cap.remaining', { remaining: remainingToday })}
      </span>
    </div>
  );
}
