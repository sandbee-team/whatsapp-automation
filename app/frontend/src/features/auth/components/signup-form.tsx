import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { signupInputSchema } from '@wp/contracts';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Card, CardBody, Input, PasswordInput, useT } from '@wp/ui';
import { CircleCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError } from '../../../lib/api-client.js';
import { signup, type SignupInput } from '../api.js';
import { PasswordStrengthMeter } from './password-strength-meter.js';

const COPY = ONBOARDING_COPY.signup;

export function SignupForm(): React.JSX.Element {
  const t = useT();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [succeeded, setSucceeded] = React.useState(false);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({ resolver: zodResolver(signupInputSchema) });
  const password = watch('password') ?? '';

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await signup(values);
      setSucceeded(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        setSubmitError(COPY.duplicateAccountError);
      } else if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        // Fixed in C2 hardening - a VALIDATION_ERROR previously fell through
        // to the generic message, hiding the server's actual field-level
        // reason (same forwarding idiom as EndpointForm/ContactForm/
        // TopupRequestForm's own ApiError handling).
        setSubmitError(error.message);
      } else {
        setSubmitError(COPY.genericError);
      }
    }
  });

  if (succeeded) {
    return (
      <AuthLayout title={COPY.successTitle}>
        <Card padding="none" className="border-none shadow-none">
          <CardBody className="flex flex-col items-center gap-3 text-center">
            <CircleCheck aria-hidden size={40} className="text-success" />
            <p className="text-sm text-fg">{COPY.successBody}</p>
            {import.meta.env.DEV ? (
              <p className="text-xs text-muted">{t('shell.auth.devMailpitHint')}</p>
            ) : null}
          </CardBody>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={COPY.title}
      footer={
        <span>
          {COPY.loginLinkPrompt}{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            {COPY.loginLinkLabel}
          </Link>
        </span>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <Input
          label={COPY.fullNameLabel}
          data-testid="signup-full-name"
          autoFocus
          autoComplete="name"
          required
          error={errors.fullName?.message}
          {...register('fullName')}
        />

        <Input
          label={COPY.emailLabel}
          type="email"
          data-testid="signup-email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label={COPY.phoneLabel}
          data-testid="signup-phone"
          autoComplete="tel"
          required
          error={errors.phoneE164?.message}
          {...register('phoneE164')}
        />

        <Input
          label={COPY.companyNameLabel}
          data-testid="signup-company"
          autoComplete="organization"
          required
          error={errors.companyName?.message}
          {...register('companyName')}
        />

        <PasswordInput
          label={COPY.passwordLabel}
          description={COPY.passwordHint}
          error={errors.password?.message}
          required
          showLabel={t('shell.auth.showPassword')}
          hideLabel={t('shell.auth.hidePassword')}
          data-testid="signup-password"
          autoComplete="new-password"
          {...register('password')}
        />
        <PasswordStrengthMeter password={password} />

        {submitError ? <Alert tone="danger" title={submitError} /> : null}

        <Button type="submit" data-testid="signup-submit" loading={isSubmitting} className="mt-2">
          {COPY.submitButton}
        </Button>
      </form>
    </AuthLayout>
  );
}
