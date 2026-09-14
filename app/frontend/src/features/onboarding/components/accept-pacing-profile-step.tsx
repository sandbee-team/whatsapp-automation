import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Card, CardBody } from '@wp/ui';
import { useState } from 'react';
import { ApiError } from '../../../lib/api-client.js';
import { setPacingProfile } from '../api.js';
import { WizardStepHeader } from '../wizard-step-header.js';

const COPY = ONBOARDING_COPY.wizard.acceptPacingProfile;
const SAFE_DEFAULT_PROFILE_KEY = 'safe_default';

export function AcceptPacingProfileStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await setPacingProfile({ profileKey: SAFE_DEFAULT_PROFILE_KEY });
      onDone();
    } catch (error) {
      setSubmitError(
        error instanceof ApiError && error.code === 'CONFLICT'
          ? COPY.stepUnavailableError
          : COPY.genericError,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div data-testid="wizard-accept-pacing-profile" className="flex flex-col gap-4">
      <WizardStepHeader title={COPY.title} description={COPY.body} />

      <Card padding="sm" className="border-accent/40 bg-accent-soft/40">
        <CardBody className="flex flex-col gap-2">
          <label htmlFor="wizard-pacing-profile" className="flex items-center gap-2">
            <input
              id="wizard-pacing-profile"
              type="radio"
              data-testid="wizard-pacing-profile-safe-default"
              checked
              readOnly
              className="h-4 w-4 accent-accent"
            />
            <span className="text-sm font-medium font-ui text-fg">{COPY.profileLabel}</span>
          </label>
          <p className="text-xs text-muted">{COPY.disclaimer}</p>
        </CardBody>
      </Card>

      {submitError ? <Alert tone="danger" title={submitError} /> : null}

      <Button
        type="button"
        data-testid="wizard-pacing-profile-submit"
        loading={isSubmitting}
        onClick={() => void onSubmit()}
      >
        {COPY.submitButton}
      </Button>
    </div>
  );
}
