import { createFileRoute } from '@tanstack/react-router';
import { ContactsList } from '../../features/contacts/index.js';

/**
 * `/contacts` (P20 Unit U9, step 10) - the tenant address-book screen: list,
 * search, opt-out/tag filters, add/import/export actions, contact drawer. No
 * onboarding-status guard beyond the parent `_authed` layout's session
 * check, same as `/unresolved` and `/settings/webhooks`.
 */
export const Route = createFileRoute('/_authed/contacts')({
  component: ContactsList,
});
