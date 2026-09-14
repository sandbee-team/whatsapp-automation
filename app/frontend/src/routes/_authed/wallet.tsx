import { createFileRoute } from '@tanstack/react-router';
import { WalletScreen } from '../../features/wallet/index.js';

/**
 * `/wallet` (P26b U5, new route) - the tenant wallet screen: balance/state/
 * estimated-remaining/spent-today KPIs, the top-up request form, and the
 * top-up request history. No onboarding-status guard beyond the parent
 * `_authed` layout's session check, same as `/contacts`/`/groups`.
 */
export const Route = createFileRoute('/_authed/wallet')({
  component: WalletScreen,
});
