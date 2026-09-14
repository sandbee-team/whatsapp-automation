import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Composer } from '../../features/broadcasts/index.js';

/**
 * `/broadcasts/new` (P23a Unit U4; typed navigate wired in Unit U5 once
 * `/broadcasts/$id` landed) - the composer screen: name, audience, message +
 * variables, priority, optional schedule, then the existing `PreflightPanel`
 * before start. No onboarding-status guard beyond the parent `_authed`
 * layout's session check, same as `/contacts` and `/settings/webhooks`.
 *
 * A successful start navigates via the typed `to: '/broadcasts/$id'` helper
 * (never the untyped `router.navigate({ href })` form) now that the detail
 * route exists.
 */
export const Route = createFileRoute('/_authed/broadcasts/new')({
  component: BroadcastComposerRoute,
});

function BroadcastComposerRoute(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <Composer
      onStarted={(id) => {
        void navigate({ to: '/broadcasts/$id', params: { id } });
      }}
    />
  );
}
