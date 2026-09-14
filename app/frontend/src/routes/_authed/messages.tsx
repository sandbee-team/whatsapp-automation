import { createFileRoute } from '@tanstack/react-router';
import { Composer } from '../../features/messages/compose/Composer.js';

/**
 * `/messages` (P11 U6a) - the send-path MVP's composer entry point. No
 * extra `beforeLoad` guard beyond the parent `_authed` layout's session
 * check: unlike `/instances`, sending a message has no onboarding-status
 * precondition of its own here (the composer's own account-id field is the
 * only per-send input this route needs - see `Composer.tsx`'s doc comment
 * on the account-picker gap).
 */
export const Route = createFileRoute('/_authed/messages')({
  component: Composer,
});
