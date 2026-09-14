import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ONBOARDING_COPY } from '@wp/domain';
import { ErrorState, Skeleton, useT, type StepperStep } from '@wp/ui';
import type { MessageKey } from '@wp/i18n';
import { AcceptPacingProfileStep } from './components/accept-pacing-profile-step.js';
import { AttestConsentStep } from './components/attest-consent-step.js';
import { ChooseTimezoneStep } from './components/choose-timezone-step.js';
import { ConnectWhatsappStep } from './components/connect-whatsapp-step.js';
import { DoneStep } from './components/done-step.js';
import { VerifyEmailStep } from './components/verify-email-step.js';
import { WizardLayout } from './wizard-layout.js';
import { getOnboardingStatus } from './api.js';

const COPY = ONBOARDING_COPY.wizard;
const ONBOARDING_STATUS_QUERY_KEY = ['onboarding', 'status'] as const;
const TOTAL_STEPS = 5;

const STEP_LABEL_KEYS: MessageKey[] = [
  'shell.wizard.stepVerifyEmail',
  'shell.wizard.stepTimezone',
  'shell.wizard.stepPacingProfile',
  'shell.wizard.stepConsent',
  'shell.wizard.stepConnect',
];

const STEP_DESCRIPTION_KEYS: MessageKey[] = [
  'onboarding.wizard.stepDescription.verifyEmail',
  'onboarding.wizard.stepDescription.timezone',
  'onboarding.wizard.stepDescription.pacingProfile',
  'onboarding.wizard.stepDescription.consent',
  'onboarding.wizard.stepDescription.connect',
];

const STEP_INDEX: Record<string, number> = {
  verify_email: 0,
  choose_timezone: 1,
  accept_pacing_profile: 2,
  attest_consent: 3,
  connect_whatsapp: 4,
  send_test: 4,
  done: 4,
};

/**
 * The onboarding wizard: reads `GET /v1/onboarding` to resume at the
 * caller's current step (step enum order: verify_email -> choose_timezone
 * -> accept_pacing_profile -> attest_consent -> connect_whatsapp ->
 * send_test -> done). Each step component calls its own mutation then
 * invalidates the status query so the wizard re-renders at the next step -
 * the wizard itself never advances the step locally. Restyled per the
 * panel-refresh spec (section 6): a `WizardLayout` rail + card, one `Stepper`
 * mounted at a time (`WizardLayout`'s `matchMedia` switch), a "Step N of 5"
 * eyebrow above the card, and the `done` step renders no rail/eyebrow.
 */
export function OnboardingWizard(): React.JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ONBOARDING_STATUS_QUERY_KEY,
    queryFn: getOnboardingStatus,
  });

  const advance = (): void => {
    void queryClient.invalidateQueries({ queryKey: ONBOARDING_STATUS_QUERY_KEY });
  };

  const steps: StepperStep[] = STEP_LABEL_KEYS.map((labelKey, index) => ({
    id: labelKey,
    label: t(labelKey),
    description: t(STEP_DESCRIPTION_KEYS[index]!),
  }));

  if (isLoading) {
    return (
      <div className="min-h-screen lg:grid lg:grid-cols-[320px_1fr]" data-testid="wizard-loading">
        <div className="hidden flex-col gap-4 border-r border-border bg-sidebar p-8 lg:flex">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="flex flex-1 items-center justify-center p-6 lg:p-12">
          <Skeleton className="h-96 w-full max-w-xl rounded-2xl" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-xl py-10" data-testid="wizard-error">
        <ErrorState
          title={COPY.genericError}
          retryAction={
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium font-ui text-accent-fg hover:bg-accent-hover"
            >
              {COPY.retryButton}
            </button>
          }
        />
      </div>
    );
  }

  const currentIndex = STEP_INDEX[data.step] ?? 0;

  if (data.step === 'done') {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <DoneStep />
      </div>
    );
  }

  return (
    <WizardLayout
      railTitle={COPY.title}
      steps={steps}
      current={currentIndex}
      stepKey={data.step}
      stepNumber={currentIndex + 1}
      totalSteps={TOTAL_STEPS}
    >
      {data.step === 'verify_email' ? <VerifyEmailStep /> : null}
      {data.step === 'choose_timezone' ? <ChooseTimezoneStep onDone={advance} /> : null}
      {data.step === 'accept_pacing_profile' ? <AcceptPacingProfileStep onDone={advance} /> : null}
      {data.step === 'attest_consent' ? <AttestConsentStep onDone={advance} /> : null}
      {data.step === 'connect_whatsapp' || data.step === 'send_test' ? (
        <ConnectWhatsappStep isCurrentStep={data.step === 'connect_whatsapp'} />
      ) : null}
    </WizardLayout>
  );
}
