import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, Input, OtpInput, PasswordInput, useT } from '@wp/ui';
import { ApiError } from '../../../lib/api-client.js';
import { staffLogin } from '../api.js';

/**
 * login-form.tsx (P28 Unit U6, step 9) - staff sign-in: email + password +
 * mandatory 6-digit TOTP (`staffLoginInputSchema`: all three fields
 * required). Honest error copy per code: `ACCOUNT_LOCKED` -> inline lock
 * message, `MFA_ENROLL_REQUIRED` -> "ask a superadmin" (never implies the
 * staff member did anything wrong), `FORBIDDEN` -> "network not allow-
 * listed" (never a generic "access denied").
 */
export function LoginForm(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [totpCode, setTotpCode] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && totpCode.length === 6;

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await staffLogin({ email, password, totpCode });
      await navigate({ to: '/clients' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ACCOUNT_LOCKED') {
        setSubmitError(t('admin.login.accountLocked'));
      } else if (error instanceof ApiError && error.code === 'MFA_ENROLL_REQUIRED') {
        setSubmitError(t('admin.login.mfaEnrollRequired'));
      } else if (error instanceof ApiError && error.code === 'FORBIDDEN') {
        setSubmitError(t('admin.login.forbidden'));
      } else {
        setSubmitError(t('admin.login.genericError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold font-ui text-fg">{t('admin.login.title')}</h1>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          <Input
            label={t('admin.login.emailLabel')}
            type="email"
            data-testid="admin-login-email"
            autoFocus
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordInput
            label={t('admin.login.passwordLabel')}
            data-testid="admin-login-password"
            autoComplete="current-password"
            required
            showLabel={t('shell.auth.showPassword')}
            hideLabel={t('shell.auth.hidePassword')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <OtpInput
            label={t('admin.login.totpLabel')}
            value={totpCode}
            onValueChange={setTotpCode}
          />

          {submitError ? <Alert tone="danger" title={submitError} /> : null}

          <Button
            type="submit"
            data-testid="admin-login-submit"
            disabled={!canSubmit}
            loading={submitting}
            className="mt-2"
          >
            {t('admin.login.submitButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}
