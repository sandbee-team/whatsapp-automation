import { createFileRoute } from '@tanstack/react-router';
import { BroadcastList } from '../../features/broadcasts/index.js';

/**
 * `/broadcasts` (P23a Unit U5) - the list screen. No onboarding-status guard
 * beyond the parent `_authed` layout's session check, same as `/contacts`
 * and `/broadcasts/new`.
 */
export const Route = createFileRoute('/_authed/broadcasts/')({
  component: BroadcastList,
});
