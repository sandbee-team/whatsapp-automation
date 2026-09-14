import { createFileRoute } from '@tanstack/react-router';
import { GroupsScreen } from '../../features/groups/index.js';

/**
 * `/groups` (P24 groups-messaging, Unit U5) - the tenant group-sending
 * surface: pick a number, sync/manage its WhatsApp groups. No onboarding-
 * status guard beyond the parent `_authed` layout's session check, same as
 * `/contacts`/`/broadcasts`.
 */
export const Route = createFileRoute('/_authed/groups')({
  component: GroupsScreen,
});
