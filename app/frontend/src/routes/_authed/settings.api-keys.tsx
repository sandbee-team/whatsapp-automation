import { createFileRoute } from '@tanstack/react-router';
import { ApiKeyList } from '../../features/api-keys/index.js';

/**
 * `/settings/api-keys` (go-live U5) - the tenant API keys settings screen:
 * list, create (with the once-only key reveal), and revoke. No
 * onboarding-status guard beyond the parent `_authed` layout's session
 * check, same as `/settings/webhooks`.
 */
export const Route = createFileRoute('/_authed/settings/api-keys')({
  component: ApiKeyList,
});
