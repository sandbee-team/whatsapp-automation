import { createFileRoute } from '@tanstack/react-router';
import { SecurityPage } from '../../features/auth/index.js';

/**
 * `/settings/security` (P26b, security follow-up) - Email/Two-factor/
 * Password/Session cards. No onboarding-status guard beyond the parent
 * `_authed` layout's session check, same as `/settings/webhooks`.
 */
export const Route = createFileRoute('/_authed/settings/security')({
  component: SecurityPage,
});
