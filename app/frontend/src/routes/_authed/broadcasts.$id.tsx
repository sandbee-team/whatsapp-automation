import { createFileRoute } from '@tanstack/react-router';
import { BroadcastDetail } from '../../features/broadcasts/index.js';

/**
 * `/broadcasts/$id` (P23a Unit U5) - the detail screen: funnel, Pause/
 * Resume/Cancel confirms. No onboarding-status guard beyond the parent
 * `_authed` layout's session check, same as `/broadcasts` and
 * `/broadcasts/new`.
 */
export const Route = createFileRoute('/_authed/broadcasts/$id')({
  component: BroadcastDetailRoute,
});

function BroadcastDetailRoute(): React.JSX.Element {
  const { id } = Route.useParams();
  return <BroadcastDetail id={id} />;
}
