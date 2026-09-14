import { createFileRoute } from '@tanstack/react-router';
import { UnresolvedSendsScreen } from '../../features/unresolved/index.js';

/**
 * `/unresolved` (P12 U6a, step 9) - the "Unresolved sends" panel entry
 * point: per-instance Retry (may duplicate) / Discard (may have been
 * delivered) actions on jobs the reconciler could not confirm
 * (`blocked_needs_review`). No onboarding-status guard beyond the parent
 * `_authed` layout's session check, same as `/messages`.
 */
export const Route = createFileRoute('/_authed/unresolved')({
  component: UnresolvedSendsScreen,
});
