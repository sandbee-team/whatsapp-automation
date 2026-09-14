import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginInputSchema } from '@wp/contracts';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Input, PasswordInput, useT } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError } from '../../../lib/api-client.js';
import { login, type LoginInput } from '../api.js';

const COPY = ONBOARDING_COPY.login;

export function LoginForm(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginInputSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await login(values);
      if (result.kind === 'mfa_required') {
        await navigate({ to: '/totp', search: { mfaToken: result.mfaToken } });
        return;
      }
      await navigate({ to: '/' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ACCOUNT_LOCKED') {
        setSubmitError(COPY.accountLockedError);
      } else if (error instanceof ApiError && error.code === 'EMAIL_NOT_VERIFIED') {
        setSubmitError(COPY.emailNotVerifiedError);
      } else if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
        setSubmitError(COPY.invalidCredentialsError);
      } else if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        // Fixed in C2 hardening - same forwarding idiom as SignupForm/
        // EndpointForm/ContactForm/TopupRequestForm: a VALIDATION_ERROR
        // previously fell through to the generic message.
        setSubmitError(error.message);
      } else {
        setSubmitError(COPY.genericError);
      }
    }
  });

  return (
    <AuthLayout
      title={COPY.title}
      footer={
        <span>
          {COPY.signupLinkPrompt}{' '}
          <Link to="/signup" className="font-medium text-accent hover:underline">
            {COPY.signupLinkLabel}
          </Link>
        </span>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <Input
          label={COPY.emailLabel}
          type="email"
          data-testid="login-email"
          autoFocus
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <PasswordInput
          label={COPY.passwordLabel}
          data-testid="login-password"
          autoComplete="current-password"
          required
          showLabel={t('shell.auth.showPassword')}
          hideLabel={t('shell.auth.hidePassword')}
          error={errors.password?.message}
          {...register('password')}
        />

        {submitError ? <Alert tone="danger" title={submitError} /> : null}

        <Button type="submit" data-testid="login-submit" loading={isSubmitting} className="mt-2">
          {COPY.submitButton}
        </Button>

        <Link
          to="/forgot-password"
          className="w-fit text-sm font-medium text-accent hover:underline"
          data-testid="login-forgot-password"
        >
          {t('shell.auth.forgotPasswordLink')}
        </Link>
      </form>
    </AuthLayout>
  );
}
