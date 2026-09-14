import { ONBOARDING_COPY } from '@wp/domain';
import { useT } from '@wp/ui';
import { MailCheck } from 'lucide-react';
import { WizardStepHeader } from '../wizard-step-header.js';

const COPY = ONBOARDING_COPY.wizard.verifyEmailPending;

export function VerifyEmailStep(): React.JSX.Element {
  const t = useT();

  return (
    <div data-testid="wizard-verify-email" className="flex flex-col items-center gap-3 text-center">
      <MailCheck aria-hidden size={32} className="text-accent" />
      <WizardStepHeader title={COPY.title} description={COPY.body} />
      {import.meta.env.DEV ? (
        <p className="text-xs text-subtle">{t('shell.auth.devMailpitHint')}</p>
      ) : null}
    </div>
  );
}
