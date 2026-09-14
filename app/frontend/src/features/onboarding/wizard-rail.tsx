import * as React from 'react';
import { Stepper, useT, type StepperOrientation, type StepperStep } from '@wp/ui';
import { BrandMark } from '../../components/brand/brand-mark.js';

/**
 * WizardRail (panel-refresh spec section 6) - the left setup rail: brand row,
 * "Workspace setup" eyebrow, wizard title, the `Stepper` (orientation passed
 * in by `WizardLayout` so exactly one `Stepper` is ever mounted - two would
 * double the `listitem` count in jsdom, which has no CSS to hide either
 * copy) and a bottom reassurance line. `steps=[]`/`hidden` on the done step
 * is the caller's job (it renders no rail content at all on `done`).
 */
export interface WizardRailProps {
  title: string;
  steps: StepperStep[];
  current: number;
  orientation: StepperOrientation;
  className?: string;
}

export function WizardRail({
  title,
  steps,
  current,
  orientation,
  className,
}: WizardRailProps): React.JSX.Element {
  const t = useT();

  return (
    <div className={className}>
      <div className="mb-8">
        <BrandMark size="md" variant="auth" />
      </div>

      <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
        {t('onboarding.wizard.railEyebrow')}
      </span>
      <h1 className="mb-6 mt-1 text-2xl font-semibold font-ui tracking-tight text-fg">{title}</h1>

      <Stepper
        steps={steps}
        current={current}
        orientation={orientation}
        completedLabel={t('shell.stepper.completed')}
        currentLabel={t('shell.stepper.current')}
        upcomingLabel={t('shell.stepper.upcoming')}
      />

      <p className="mt-8 text-xs text-muted">{t('onboarding.wizard.reassurance')}</p>
    </div>
  );
}
