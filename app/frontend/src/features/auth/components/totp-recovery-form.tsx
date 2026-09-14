import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { totpRecoveryInputSchema } from '@wp/contracts';
import { Alert, Button, Input, useT } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError } from '../../../lib/api-client.js';
import { totpRecovery, type TotpRecoveryInput } from '../api.js';

/**
 * TotpRecoveryForm (P05 U5, carried debt) - the recovery-code login
 * continuation, reachable from `/totp` (see `auth.recovery.link`). Copy
 * comes from `@wp/i18n` via `useT()`, not `ONBOARDING_COPY` (that copy
 * source is reserved for the P04b signup/login/onboarding surfaces built
 * before `@wp/i18n` existed) - every string here is a `t('auth.recovery.*')`
 * call.
 */
export function TotpRecoveryForm({ mfaToken }: { mfaToken: string }): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TotpRecoveryInput>({
    resolver: zodResolver(totpRecoveryInputSchema),
    defaultValues: { mfaToken },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await totpRecovery(values);
      await navigate({ to: '/' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
        setSubmitError(t('auth.recovery.invalid'));
      } else {
        setSubmitError(t('common.error.generic'));
      }
    }
  });

  return (
    <AuthLayout title={t('auth.recovery.title')}>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <input type="hidden" {...register('mfaToken')} />

        <Input
          label={t('auth.recovery.code')}
          data-testid="totp-recovery-code"
          autoFocus
          required
          error={errors.recoveryCode?.message}
          {...register('recoveryCode')}
        />

        {submitError ? <Alert tone="danger" title={submitError} /> : null}

        <Button type="submit" data-testid="totp-recovery-submit" loading={isSubmitting}>
          {t('auth.recovery.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
