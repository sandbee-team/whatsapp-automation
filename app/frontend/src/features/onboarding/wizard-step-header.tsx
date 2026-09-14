import * as React from 'react';

/**
 * WizardStepHeader (panel-refresh spec section 6) - the shared heading block
 * every wizard step wraps its own `title`/`description` in for consistent
 * spacing. Purely presentational: no behaviour, no copy of its own - every
 * step component keeps its existing `ONBOARDING_COPY` strings and test ids
 * unchanged, only the JSX wrapper moves.
 */
export interface WizardStepHeaderProps {
  title: string;
  description?: string;
}

export function WizardStepHeader({ title, description }: WizardStepHeaderProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold font-ui text-fg">{title}</h2>
      {description ? <p className="text-sm text-muted">{description}</p> : null}
    </div>
  );
}
