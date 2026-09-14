import { zodResolver } from '@hookform/resolvers/zod';
import { setTimezoneInputSchema } from '@wp/contracts';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Input } from '@wp/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { setTimezone, type SetTimezoneInput } from '../api.js';
import { WizardStepHeader } from '../wizard-step-header.js';

const COPY = ONBOARDING_COPY.wizard.chooseTimezone;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function ChooseTimezoneStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SetTimezoneInput>({
    resolver: zodResolver(setTimezoneInputSchema),
    defaultValues: { timezone: DEFAULT_TIMEZONE },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await setTimezone(values);
      onDone();
    } catch {
      setSubmitError(COPY.genericError);
    }
  });

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      noValidate
      data-testid="wizard-choose-timezone"
      className="flex flex-col gap-4"
    >
      <WizardStepHeader title={COPY.title} description={COPY.body} />

      <Input
        label={COPY.timezoneLabel}
        data-testid="wizard-timezone-input"
        autoFocus
        required
        error={errors.timezone?.message}
        {...register('timezone')}
      />

      {submitError ? <Alert tone="danger" title={submitError} /> : null}

      <Button type="submit" data-testid="wizard-timezone-submit" loading={isSubmitting}>
        {COPY.submitButton}
      </Button>
    </form>
  );
}
