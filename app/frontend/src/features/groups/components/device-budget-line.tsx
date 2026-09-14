import { useT } from '@wp/ui';

/**
 * DeviceBudgetLine (P24 groups-messaging, Unit U5) - the tracked-member-
 * device budget line (`groups.budget.line`) plus the honest derived-note
 * (`groups.budget.derivedNote`): the total is ESTIMATED from member counts,
 * never presented as a measured figure - core invariant 6 (honest product).
 */
export interface DeviceBudgetLineProps {
  total: number;
  max: number;
}

export function DeviceBudgetLine({ total, max }: DeviceBudgetLineProps): React.JSX.Element {
  const t = useT();

  return (
    <div data-testid="device-budget-line" className="flex flex-col gap-1">
      <span className="text-sm font-ui text-fg">{t('groups.budget.line', { total, max })}</span>
      <span className="text-sm font-ui text-muted">{t('groups.budget.derivedNote')}</span>
    </div>
  );
}
