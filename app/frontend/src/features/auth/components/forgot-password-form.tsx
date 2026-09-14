import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordInputSchema } from '@wp/contracts';
import { Button, Input, useT } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { CircleCheck } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { forgotPassword, type ForgotPasswordInput } from '../api.js';

/**
 * ForgotPasswordForm (P28 Unit U7, `/forgot-password`) - ALWAYS shows the
 * same confirmation regardless of whether the email exists, never an
 * existence oracle (same discipline as `forgotPasswordContract`'s own doc
 * comment and `loginResultSchema`'s shared `UNAUTHENTICATED` code). A
 * transport/server failure still shows the confirmation - a `forgot`
 * request failing to reach the backend must not teach an attacker anything
 * different from a request that succeeded either.
 */
export function ForgotPasswordForm(): React.JSX.Element {
  const t = useT();
  const [submitted, setSubmitted] = React.useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordInputSchema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await forgotPassword(values);
    } finally {
      setSubmitted(true);
    }
  });

  if (submitted) {
    return (
      <AuthLayout title={t('shell.auth.forgotPassword.title')}>
        <div
          data-testid="forgot-password-confirmation"
          className="flex flex-col items-center gap-3 text-center"
        >
          <CircleCheck aria-hidden size={40} className="text-success" />
          <p className="text-sm text-fg">{t('shell.auth.forgotPassword.confirmation')}</p>
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t('shell.auth.forgotPassword.backToSignIn')}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('shell.auth.forgotPassword.title')}
      description={t('shell.auth.forgotPassword.description')}
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <Input
          label={t('shell.auth.forgotPassword.emailLabel')}
          type="email"
          data-testid="forgot-password-email"
          autoFocus
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <Button type="submit" data-testid="forgot-password-submit" loading={isSubmitting}>
          {t('shell.auth.forgotPassword.submitButton')}
        </Button>

        <Link
          to="/login"
          className="w-fit self-center text-sm font-medium text-accent hover:underline"
        >
          {t('shell.auth.forgotPassword.backToSignIn')}
        </Link>
      </form>
    </AuthLayout>
  );
}
