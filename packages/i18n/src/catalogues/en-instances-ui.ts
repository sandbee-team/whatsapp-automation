import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the P26b U3 dashboard and instances (filled by that
 * unit only; hi-instances-ui.ts mirrors every key). Existing `dashboard.*`,
 * `instances.*`, `notifications.*`, `wallet.*`, `queueStatus.*` keys already
 * live in `en.ts` (a different unit's scope) and are reused as-is; only the
 * NEW strings this unit introduces (checklist, numbers grid, switcher,
 * detail tabs) are added here.
 */
export const enInstancesUi = {
  'dashboard.checklist.title': 'Getting started',
  'dashboard.checklist.connect.title': 'Connect a number',
  'dashboard.checklist.connect.body': 'Link a WhatsApp number to start sending.',
  'dashboard.checklist.connect.cta': 'Connect a number',
  'dashboard.checklist.sendTest.title': 'Send your first message',
  'dashboard.checklist.sendTest.body': 'Try sending a message from a connected number.',
  'dashboard.checklist.sendTest.cta': 'Go to numbers',
  'dashboard.checklist.addFunds.title': 'Add funds',
  'dashboard.checklist.addFunds.body': 'Top up your wallet so sends keep going.',
  'dashboard.checklist.addFunds.cta': 'Go to wallet',
  'dashboard.checklist.done': 'Done',
  'dashboard.checklist.todo': 'To do',
  'dashboard.numbers.title': 'Your numbers',
  'dashboard.numbers.viewAll': 'View all',
  'dashboard.activity.title': 'Recent activity',
  'dashboard.activity.empty': 'No recent activity yet.',
  'dashboard.activity.error': 'Something went wrong. Please try again.',
  'dashboard.summary.error': 'Something went wrong loading your dashboard.',
  'dashboard.spentToday': 'Spent today',

  'instances.numbers.grid.empty.title': 'No numbers connected yet',
  'instances.numbers.grid.empty.body':
    'Connect a WhatsApp number to start sending and receiving messages.',
  'instances.numbers.grid.error.title': 'Could not load your numbers',
  'instances.numbers.grid.error.body': 'Something went wrong. Please try again.',

  'instances.switcher.allNumbers': 'All numbers',
  'instances.switcher.triggerLabel': 'Switch number',

  'instances.detail.breadcrumbLabel': 'Numbers',
  'instances.detail.pause': 'Pause',
  'instances.detail.pauseConfirmTitle': 'Pause this number?',
  'instances.detail.pauseConfirmBody':
    'Queued messages stay queued. Sending resumes only when you bring this number back online.',
  'instances.detail.resume': 'Resume',
  'instances.detail.resumeConfirmTitle': 'Resume this number?',
  'instances.detail.resumeConfirmBody': 'This number will start sending queued messages again.',
  'instances.detail.reconnect': 'Reconnect',
  'instances.detail.reconnectGoToNumbers': 'Go to Numbers to reconnect',
  'instances.detail.why': 'Why?',
  'instances.detail.pauseSuccess': 'Number paused.',
  'instances.detail.pauseError': 'Could not pause this number. Please try again.',
  'instances.detail.resumeSuccess': 'Number back online.',
  'instances.detail.resumeError': 'Could not bring this number online. Please try again.',
  'instances.detail.delete': 'Delete',
  'instances.detail.deleteConfirmTitle': 'Delete this number?',
  'instances.detail.deleteConfirmBody':
    'This removes the number from your workspace and frees up a slot on your plan for a ' +
    'replacement. Its message and queue history is kept, not erased. This cannot be undone ' +
    'from here.',
  'instances.detail.deleteSuccess': 'Number deleted.',
  'instances.detail.deleteError': 'Could not delete this number. Please try again.',
  'instances.detail.tabs.overview': 'Overview',
  'instances.detail.tabs.health': 'Health',
  'instances.detail.tabs.queue': 'Queue',
  'instances.detail.overview.todaySent': 'Sent today',
  'instances.detail.overview.newConversations': 'New conversations',
  'instances.detail.overview.queueDepth': 'Queue depth',
  'instances.detail.overview.oldestQueuedAge': 'Oldest queued (s)',
  'instances.detail.overview.sendingWindow': 'Sending window',
  'instances.detail.overview.nextSend': 'Next send',
  'instances.detail.queue.waiting': 'Waiting',
  'instances.detail.queue.sentToday': 'Sent today',
  'instances.detail.queue.failedToday': 'Failed today',
  'instances.detail.error.title': 'Could not load this number',
  'instances.detail.error.body': 'Something went wrong. Please try again.',

  'instances.connect.mfaEnrol.body':
    'Two-factor authentication is required before you can connect a number.',
  'instances.connect.mfaEnrol.button': 'Turn on two-factor',
  'instances.connect.mfaVerify.body':
    'Your current sign-in has not been verified with two-factor. Sign in again to continue.',
  'instances.connect.mfaVerify.button': 'Sign in again',
} as const satisfies Catalogue;
