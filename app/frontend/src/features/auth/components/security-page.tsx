import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { setAccessToken } from '../../../lib/api-client.js';
import { logout, me } from '../api.js';
import { ChangePasswordCard } from './change-password-card.js';

/**
 * SecurityPage (P26b, security follow-up; P28 Unit U7 completes the
 * Password card, `/settings/security`) - Email, Two-factor authentication,
 * Password and Session cards. The Two-factor card, once enabled, still says
 * re-enrolment is not available in the panel yet (HONEST COPY ONLY, core
 * invariant 6) rather than offering a control that does nothing - only the
 * Password card's own "not available yet" placeholder is replaced, by the
 * real change-password form (`ChangePasswordCard`).
 */
export function SecurityPage(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ['auth', 'me'], queryFn: me });

  const onSignOut = (): void => {
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

  if (meQuery.isLoading || !meQuery.data) {
    return (
      <div data-testid="security-screen">
        <PageHeader title={t('settings.security.title')} />
      </div>
    );
  }

  const { user } = meQuery.data;

  return (
    <div data-testid="security-screen" className="flex flex-col gap-6">
      <PageHeader title={t('settings.security.title')} />

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security.email.title')}</CardTitle>
        </CardHeader>
        <CardBody className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg">{user.email}</span>
          <Badge tone={user.emailVerifiedAt ? 'success' : 'warning'}>
            {user.emailVerifiedAt
              ? t('settings.security.email.verified')
              : t('settings.security.email.notVerified')}
          </Badge>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security.mfa.title')}</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {user.mfaEnabledAt ? (
            <>
              <Badge tone="success">
                {t('settings.security.mfa.enabledSince', {
                  date: new Date(user.mfaEnabledAt).toLocaleDateString(),
                })}
              </Badge>
              <p className="text-sm text-muted">{t('settings.security.mfa.reenrolNotAvailable')}</p>
            </>
          ) : (
            <>
              <Badge tone="warning">{t('settings.security.mfa.notSetUp')}</Badge>
              <Button
                type="button"
                size="sm"
                className="w-fit"
                data-testid="security-mfa-setup-button"
                onClick={() => void navigate({ to: '/totp' })}
              >
                {t('instances.connect.mfaEnrol.button')}
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <ChangePasswordCard />

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.security.session.title')}</CardTitle>
        </CardHeader>
        <CardBody>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-fit"
            data-testid="security-signout-button"
            onClick={onSignOut}
          >
            {t('nav.logout')}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
