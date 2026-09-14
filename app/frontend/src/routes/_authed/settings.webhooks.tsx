import { createFileRoute } from '@tanstack/react-router';
import { EndpointList } from '../../features/webhooks/index.js';

/**
 * `/settings/webhooks` (P15 U6, step 9) - the webhook endpoints settings
 * screen: list, create (with the once-only secret dialog), and a disabled-
 * endpoint explanation. No onboarding-status guard beyond the parent
 * `_authed` layout's session check, same as `/unresolved` and `/messages`.
 */
export const Route = createFileRoute('/_authed/settings/webhooks')({
  component: EndpointList,
});
