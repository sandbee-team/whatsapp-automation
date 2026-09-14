import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the P26b U5 contacts, community-chat, webhooks and
 * wallet screens (filled by that unit only; hi-data-ui.ts mirrors every
 * key). Existing `wallet.*`/`contacts.*`/`groups.*`/`webhooks.*` keys
 * already live in `en.ts`/`en-contacts.ts`/`en-groups.ts` (a different
 * unit's earlier scope) and are reused as-is; only the NEW strings the
 * `/wallet` screen and the restyled surfaces introduce are added here.
 */
export const enDataUi = {
  'wallet.title': 'Wallet',
  'wallet.subtitle': 'Balance, spend and top-up requests for your workspace.',
  'wallet.kpi.balance': 'Balance',
  'wallet.kpi.state': 'State',
  'wallet.kpi.estimatedRemaining': 'Estimated messages remaining',
  'wallet.kpi.spentToday': 'Spent today',
  'wallet.state.active': 'Active',
  'wallet.state.low': 'Low balance',
  'wallet.state.empty': 'Empty',
  'wallet.state.frozen': 'Frozen',
  'wallet.zeroBalance.title': 'Sending stops at zero balance',
  'wallet.zeroBalance.body':
    'Once your balance reaches zero, sending pauses across every connected number. Queued ' +
    'messages are never lost - they send once you add funds.',
  'wallet.topup.methodUpi': 'UPI',
  'wallet.topup.methodBankTransfer': 'Bank transfer',
  'wallet.history.title': 'Top-up request history',
  'wallet.history.loading': 'Loading…',
  'wallet.history.error': 'Something went wrong. Please try again.',
  'wallet.history.empty.title': 'No top-up requests yet',
  'wallet.history.empty.body': 'Submit a top-up request above to see it listed here.',
  'wallet.history.column.amount': 'Amount',
  'wallet.history.column.method': 'Method',
  'wallet.history.column.status': 'Status',
  'wallet.history.column.createdAt': 'Submitted',
  'wallet.history.column.note': 'Note',

  'stepper.status.completed': 'Completed',
  'stepper.status.current': 'Current step',
  'stepper.status.upcoming': 'Upcoming',

  // P26b C1 fix round MAJOR-6: a sync/toggle/leave mutation failure now
  // always raises a visible toast (previously silent for sync/toggle-off/
  // leave, and the enable dialog silently closed as if it had succeeded on
  // any error other than GROUP_NOT_SENDABLE).
  'groups.toast.actionError': 'Something went wrong. Please try again.',
} as const satisfies Catalogue;
