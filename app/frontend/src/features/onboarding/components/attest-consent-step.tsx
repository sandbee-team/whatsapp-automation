import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Checkbox } from '@wp/ui';
import { useState } from 'react';
import { ApiError } from '../../../lib/api-client.js';
import { setConsent } from '../api.js';
import { WizardStepHeader } from '../wizard-step-header.js';

const COPY = ONBOARDING_COPY.wizard.attestConsent;

export function AttestConsentStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [checked, setChecked] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await setConsent({ accepted: true });
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
    <div data-testid="wizard-attest-consent" className="flex flex-col gap-4">
      <WizardStepHeader title={COPY.title} />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold font-ui text-fg">{COPY.statementsTitle}</h3>
        <ol
          data-testid="wizard-consent-statements"
          className="list-decimal space-y-2 pl-5 text-sm text-muted"
        >
          {COPY.statements.map((statement) => (
            <li key={statement}>{statement}</li>
          ))}
        </ol>
      </div>

      <Alert tone="warning" title={COPY.banRiskDisclosure} />

      <p className="text-sm text-muted" data-testid="wizard-consent-tos-version">
        {COPY.tosVersionLabel}: {COPY.tosVersion}
      </p>

      <p className="text-sm text-muted">{COPY.attestationStatement}</p>

      <Checkbox
        id="wizard-consent-checkbox"
        data-testid="wizard-consent-checkbox"
        label={COPY.checkboxLabel}
        checked={checked}
        onCheckedChange={(next) => setChecked(next === true)}
      />

      {submitError ? <Alert tone="danger" title={submitError} /> : null}

      <Button
        type="button"
        data-testid="wizard-consent-submit"
        disabled={!checked}
        loading={isSubmitting}
        onClick={() => void onSubmit()}
      >
        {COPY.submitButton}
      </Button>
    </div>
  );
}
