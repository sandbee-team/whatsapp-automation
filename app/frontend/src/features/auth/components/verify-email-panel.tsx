import * as React from 'react';
import { ONBOARDING_COPY } from '@wp/domain';
import { Card, CardBody, Spinner, useT } from '@wp/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { AuthLayout } from '../../../components/auth-layout.js';
import { verifyEmail } from '../api.js';
import { onceForKey } from './once-per-token.js';

const COPY = ONBOARDING_COPY.verifyEmail;

type Status = 'pending' | 'verified' | 'invalid';

export function VerifyEmailPanel({ token }: { token: string | undefined }): React.JSX.Element {
  const t = useT();
  const [status, setStatus] = React.useState<Status>('pending');

  React.useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    // Shared per-token promise: every effect invocation for this token
    // (including StrictMode's mount -> cleanup -> remount dev pass) awaits
    // the SAME network call instead of firing a second one against a
    // single-use token. Only `cancelled` (setState) is per-invocation.
    void onceForKey(token, () => verifyEmail({ token }))
      .then(() => {
        if (!cancelled) setStatus('verified');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === 'pending') {
    return (
      <AuthLayout title={COPY.title}>
        <Card padding="none" className="border-none shadow-none" data-testid="verify-email-pending">
          <CardBody className="flex flex-col items-center gap-3 text-center">
            <Spinner size="lg" aria-label={t('common.loading')} />
            <p className="text-sm text-fg">{COPY.pendingBody}</p>
          </CardBody>
        </Card>
      </AuthLayout>
    );
  }

  if (status === 'verified') {
    return (
      <AuthLayout title={COPY.verifiedTitle}>
        <Card
          padding="none"
          className="border-none shadow-none"
          data-testid="verify-email-verified"
        >
          <CardBody className="flex flex-col items-center gap-3 text-center">
            <CircleCheck aria-hidden size={40} className="text-success" />
            <p className="text-sm text-fg">{COPY.verifiedBody}</p>
            <Link to="/login" className="font-medium text-accent hover:underline">
              {COPY.loginLinkLabel}
            </Link>
          </CardBody>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={COPY.invalidTitle}>
      <Card padding="none" className="border-none shadow-none" data-testid="verify-email-invalid">
        <CardBody className="flex flex-col items-center gap-3 text-center">
          <CircleX aria-hidden size={40} className="text-danger" />
          <p className="text-sm text-fg">{COPY.invalidBody}</p>
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t('shell.auth.backToSignIn')}
          </Link>
        </CardBody>
      </Card>
    </AuthLayout>
  );
}
