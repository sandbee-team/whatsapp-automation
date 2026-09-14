import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { totpVerifyInputSchema } from '@wp/contracts';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Input, useT } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError } from '../../../lib/api-client.js';
import { totpVerify, type TotpVerifyInput } from '../api.js';
import { TotpRecoveryForm } from './totp-recovery-form.js';

const COPY = ONBOARDING_COPY.totp;

/**
 * Handles both the 6-digit verify flow and (via `auth.recovery.link`) the
 * recovery-code continuation - both consume the same `mfaToken` from
 * `POST /v1/auth/login`'s `mfa_required` result, so they share this one
 * component rather than a second route.
 */
export function TotpVerifyPanel({ mfaToken }: { mfaToken: string }): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [showRecovery, setShowRecovery] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TotpVerifyInput>({
    resolver: zodResolver(totpVerifyInputSchema),
    defaultValues: { mfaToken },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await totpVerify(values);
      await navigate({ to: '/' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
        setSubmitError(COPY.invalidCodeError);
      } else {
        setSubmitError(COPY.genericError);
      }
    }
  });

  if (showRecovery) {
    return <TotpRecoveryForm mfaToken={mfaToken} />;
  }

  return (
    <AuthLayout title={COPY.verifyTitle}>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        <input type="hidden" {...register('mfaToken')} />

        <Input
          label={COPY.verifyCodeLabel}
          data-testid="totp-verify-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          error={errors.code?.message}
          {...register('code')}
        />

        {submitError ? <Alert tone="danger" title={submitError} /> : null}

        <Button type="submit" data-testid="totp-verify-submit" loading={isSubmitting}>
          {COPY.verifyButton}
        </Button>

        <Button
          type="button"
          variant="link"
          data-testid="totp-recovery-link"
          onClick={() => setShowRecovery(true)}
        >
          {t('auth.recovery.link')}
        </Button>
      </form>
    </AuthLayout>
  );
}
