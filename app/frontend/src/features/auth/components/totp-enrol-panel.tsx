import * as React from 'react';
import QRCode from 'qrcode';
import { zodResolver } from '@hookform/resolvers/zod';
import { totpEnrolConfirmInputSchema } from '@wp/contracts';
import { ONBOARDING_COPY } from '@wp/domain';
import { Alert, Button, Card, CardBody, Input, QrDisplay, useT } from '@wp/ui';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AuthLayout } from '../../../components/auth-layout.js';
import { ApiError, setAccessToken } from '../../../lib/api-client.js';
import { logout, totpEnrol, totpEnrolConfirm, type TotpEnrolConfirmInput } from '../api.js';
import { onceForKey } from './once-per-token.js';

const COPY = ONBOARDING_COPY.totp;

/**
 * Fixed key: unlike verify-email's per-token key, there is only ever one
 * enrolment in flight per process. `evictOnRejection: true` (unlike
 * verify-email's default) - a failed enrol call (e.g. racing an expired
 * Bearer token) must remain retryable, and each successful call seals a NEW
 * pending secret server-side, so a StrictMode double-invoke must never
 * produce two real calls for one mount.
 */
const TOTP_ENROL_KEY = 'totp-enrol';

function useOtpauthDataUrl(otpauthUrl: string | undefined): string | null {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!otpauthUrl) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(otpauthUrl).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  return dataUrl;
}

export function TotpEnrolPanel(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [enrolment, setEnrolment] = React.useState<{
    otpauthUrl: string;
    secretShownOnce: string;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TotpEnrolConfirmInput>({ resolver: zodResolver(totpEnrolConfirmInputSchema) });
  const qrDataUrl = useOtpauthDataUrl(enrolment?.otpauthUrl);

  /**
   * Enrolling TOTP does NOT upgrade the current session (canon) - the
   * honest continue action is the SAME sign-out-then-redirect logic as the
   * user menu's logout, never a plain navigate that leaves the user on a
   * still-unverified session. A fresh login is what actually mints a
   * verified `mfa` session (`/totp?mfaToken` -> `/totp/verify`).
   */
  const signInAgain = (): void => {
    void (async () => {
      try {
        await logout();
      } finally {
        setAccessToken(null);
        queryClient.clear();
        await navigate({ to: '/login' });
      }
    })();
  };

  React.useEffect(() => {
    void onceForKey(TOTP_ENROL_KEY, totpEnrol, { evictOnRejection: true })
      .then(setEnrolment)
      .catch(() => {
        // Swallowed here: enrolment failure has no dedicated error UI in
        // this panel today (out of this fix's scope). Eviction above still
        // makes the call retryable on the next mount/effect invocation.
      });
  }, []);

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await totpEnrolConfirm(values);
      setRecoveryCodes(result.recoveryCodes);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        setSubmitError(COPY.invalidCodeError);
      } else {
        setSubmitError(COPY.genericError);
      }
    }
  });

  if (recoveryCodes) {
    return (
      <AuthLayout title={COPY.recoveryCodesTitle} description={COPY.recoveryCodesBody}>
        <div data-testid="totp-recovery-codes" className="flex flex-col gap-4">
          <p className="text-xs text-muted">{t('shell.auth.recoveryCodesCopyHint')}</p>
          <ul
            role="list"
            className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface-2 p-4 font-mono text-sm"
          >
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <Button type="button" data-testid="totp-enrol-continue" onClick={signInAgain}>
            {t('shell.auth.totpEnrolContinueButton')}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={COPY.enrolTitle} description={COPY.enrolBody}>
      <div className="flex flex-col gap-4">
        {enrolment ? (
          <>
            {qrDataUrl ? (
              <QrDisplay src={qrDataUrl} size={200} label={COPY.enrolTitle} className="mx-auto" />
            ) : null}
            <Card padding="sm">
              <CardBody className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">{COPY.secretLabel}</span>
                <span data-testid="totp-secret" className="break-all font-mono text-sm text-fg">
                  {enrolment.secretShownOnce}
                </span>
              </CardBody>
            </Card>
          </>
        ) : null}

        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          <Input
            label={COPY.confirmCodeLabel}
            data-testid="totp-enrol-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            error={errors.code?.message}
            {...register('code')}
          />

          {submitError ? <Alert tone="danger" title={submitError} /> : null}

          <Button type="submit" data-testid="totp-enrol-confirm" loading={isSubmitting}>
            {COPY.confirmButton}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
