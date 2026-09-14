import { createFileRoute } from '@tanstack/react-router';
import { InstancesScreen } from '../../features/instances/index.js';

/**
 * `/instances` (P08 U7; renamed to `instances.index.tsx` in P26b U3 so
 * `instances.$id.tsx` can be its detail-route sibling) - the connect/manage-
 * numbers entry point once onboarding is `connect_whatsapp` or later
 * (`/_authed/index.tsx`'s own `beforeLoad` already redirects anyone earlier
 * to `/onboarding` - this route is for connecting/managing numbers
 * afterward, hence no duplicate onboarding-status guard here).
 */
export const Route = createFileRoute('/_authed/instances/')({
  component: InstancesScreen,
});
