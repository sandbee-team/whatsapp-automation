import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { passwordSchema } from '@wp/contracts';
import { Button, ErrorState, PasswordInput, useT, useToast } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError } from '../../../lib/api-client.js';
import { resetPassword } from '../api.js';

/**
 * ResetPasswordForm (P28 Unit U7, `/reset-password?token=`) - consumes the
 * one-time link minted by the forgot-password flow. A missing token, or a
 * 400 from the backend (expired/already-used/unknown token - all the same
 * response by design, never an oracle), renders the `ErrorState` with a
 * "Request a new link" action back to `/forgot-password`; there is no retry
 * on the same token because a reset token is single-use by contract.
 */
const resetPasswordFormSchema = z
  .object({
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'MISMATCH',
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

export interface ResetPasswordFormProps {
  token?: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [invalidToken, setInvalidToken] = React.useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isValid },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordFormSchema),
    mode: 'onChange',
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!token) {
      setInvalidToken(true);
      return;
    }
    try {
      await resetPassword({ token, newPassword: values.newPassword });
      showToast({ title: t('shell.auth.resetPassword.successToast'), tone: 'success' });
      await navigate({ to: '/login' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setInvalidToken(true);
        return;
      }
      showToast({ title: t('settings.security.password.genericError'), tone: 'danger' });
    }
  });

  if (!token || invalidToken) {
    return (
      <AuthLayout title={t('shell.auth.resetPassword.title')}>
        <ErrorState
          data-testid="reset-password-invalid-token"
          title={t('shell.auth.resetPassword.invalidTokenTitle')}
          body={t('shell.auth.resetPassword.invalidTokenBody')}
          retryAction={
            <Link
              to="/forgot-password"
              className="text-sm font-medium text-accent hover:underline"
              data-testid="reset-password-request-new-link"
            >
              {t('shell.auth.resetPassword.requestNewLinkButton')}
            </Link>
          }
        />
      </AuthLayout>
    );
  }

  const confirmError =
    errors.confirmPassword?.message === 'MISMATCH'
      ? t('shell.auth.resetPassword.confirmMismatch')
      : errors.confirmPassword?.message;

  return (
    <AuthLayout
      title={t('shell.auth.resetPassword.title')}
      description={t('shell.auth.resetPassword.description')}
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <PasswordInput
          label={t('shell.auth.resetPassword.newLabel')}
          description={t('settings.security.password.newDescription')}
          data-testid="reset-password-new"
          autoFocus
          autoComplete="new-password"
          required
          showLabel={t('shell.auth.showPassword')}
          hideLabel={t('shell.auth.hidePassword')}
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />

        <PasswordInput
          label={t('shell.auth.resetPassword.confirmLabel')}
          data-testid="reset-password-confirm"
          autoComplete="new-password"
          required
          showLabel={t('shell.auth.showPassword')}
          hideLabel={t('shell.auth.hidePassword')}
          error={confirmError}
          {...register('confirmPassword')}
        />

        <Button
          type="submit"
          data-testid="reset-password-submit"
          loading={isSubmitting}
          disabled={!isValid || isSubmitting}
        >
          {t('shell.auth.resetPassword.submitButton')}
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
