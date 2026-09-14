import { ONBOARDING_COPY } from '@wp/domain';
import { ProgressRing, Reveal, Stagger, useT } from '@wp/ui';
import { Check } from 'lucide-react';
import { Link } from '@tanstack/react-router';

const COPY = ONBOARDING_COPY.wizard.done;

/**
 * DoneStep (panel-refresh spec section 6) - a `pop-in` success `ProgressRing`
 * (value 100, a lucide `Check` centred) followed by title/body/CTA inside a
 * `Stagger`. `data-testid="wizard-done"` and the copy are unchanged from the
 * pre-refresh version.
 */
export function DoneStep(): React.JSX.Element {
  const t = useT();

  return (
    <div data-testid="wizard-done" className="flex flex-col items-center gap-3 text-center">
      <Reveal variant="pop">
        <ProgressRing value={100} tone="success" label={t('onboarding.wizard.doneRingLabel')}>
          <Check aria-hidden size={28} className="text-success" />
        </ProgressRing>
      </Reveal>
      <Stagger stepMs={80} className="flex flex-col items-center gap-3">
        <h2 className="text-lg font-semibold font-ui text-fg">{COPY.title}</h2>
        <p className="text-sm text-muted">{COPY.body}</p>
        <Link
          to="/"
          className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium font-ui text-accent-fg hover:bg-accent-hover"
        >
          {t('shell.wizard.continueToDashboard')}
        </Link>
      </Stagger>
    </div>
  );
}
