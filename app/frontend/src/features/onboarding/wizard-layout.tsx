import * as React from 'react';
import { Card, CardBody, Reveal, useT, type StepperStep } from '@wp/ui';
import { WizardRail } from './wizard-rail.js';

const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * useIsDesktop - the ONE matchMedia read that decides whether `WizardLayout`
 * renders the rail's vertical `Stepper` (desktop) or a horizontal one above
 * the card (below `lg`). jsdom (tests) has no CSS, so rendering BOTH would
 * double the `listitem` count that `wizard.test.tsx` counts - this hook is
 * the single source of truth for which ONE gets mounted. Guarded for jsdom
 * environments that lack `matchMedia` (falls back to desktop=false, matching
 * `window.innerWidth` unavailable rather than throwing).
 */
function useIsDesktop(): boolean {
  const getSnapshot = React.useCallback(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(DESKTOP_QUERY).matches
        : false,
    [],
  );
  const subscribe = React.useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => undefined;
    }
    const mql = window.matchMedia(DESKTOP_QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export interface WizardLayoutProps {
  railTitle: string;
  steps: StepperStep[];
  current: number;
  stepKey: string;
  stepNumber: number;
  totalSteps: number;
  children: React.ReactNode;
}

export function WizardLayout({
  railTitle,
  steps,
  current,
  stepKey,
  stepNumber,
  totalSteps,
  children,
}: WizardLayoutProps): React.JSX.Element {
  const t = useT();
  const isDesktop = useIsDesktop();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[320px_1fr]">
      {isDesktop ? (
        <WizardRail
          title={railTitle}
          steps={steps}
          current={current}
          orientation="vertical"
          className="border-r border-border bg-sidebar p-8"
        />
      ) : null}

      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 lg:p-12">
        {!isDesktop ? (
          <WizardRail
            title={railTitle}
            steps={steps}
            current={current}
            orientation="horizontal"
            className="w-full max-w-xl"
          />
        ) : null}

        <Reveal key={stepKey} variant="rise" className="w-full max-w-xl">
          <Card padding="none" className="rounded-2xl p-8 shadow-elevated">
            <CardBody className="flex flex-col gap-4">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                {t('onboarding.wizard.stepOf', { current: stepNumber, total: totalSteps })}
              </span>
              {children}
            </CardBody>
          </Card>
        </Reveal>
      </div>
    </div>
  );
}
