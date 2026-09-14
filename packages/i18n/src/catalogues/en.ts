/**
 * English catalogue (P05 step 2) - flat dot-keys, `{name}`-style
 * placeholders. Source of truth for `MessageKey`; `hi.ts` must carry the
 * identical key set (see `catalogue-parity.test.ts`). HONEST COPY ONLY: no
 * delivery-speed or restriction-avoidance claims anywhere (core invariant
 * 6) - the empty dashboard states zero connected numbers/queued/sent and
 * invites the user to connect a number, promising nothing else.
 *
 * `@wp/i18n` carries zero dependencies (ADR 0007, this package's own
 * `index.ts` doc) so it cannot import `@wp/domain` - `SAFE_MODE_DISCLAIMER_
 * LITERAL` and `PARKED_COPY_LITERAL` below are therefore byte-identical
 * COPIES of `@wp/domain`'s `SAFE_MODE_DISCLAIMER` / `PARKED_COPY`, not
 * re-exports, same idiom as `packages/domain/src/copy/onboarding.ts`'s own
 * `SAFE_MODE_DISCLAIMER_LITERAL` - `scripts/check-copy.ts` does a plain
 * substring match of this file's own text on disk, so the literal has to
 * live in THIS file's source bytes. A drift-guard test
 * (`instances/__tests__/instance-card.test.tsx`'s parity assertion and
 * `packages/i18n/test/catalogue-copy-parity.test.ts`) proves both stay
 * byte-identical to their `@wp/domain` source.
 */
import type { Catalogue } from './catalogue-type.js';
import { enContacts } from './en-contacts.js';
import { enBroadcasts } from './en-broadcasts.js';
import { enGroups } from './en-groups.js';
import { enShell } from './en-shell.js';
import { enInstancesUi } from './en-instances-ui.js';
import { enMessagingUi } from './en-messaging-ui.js';
import { enDataUi } from './en-data-ui.js';
import { enDashboard } from './en-dashboard.js';
import { enOnboarding } from './en-onboarding.js';
import { enShellRefresh } from './en-shell-refresh.js';
import { enNumbers } from './en-numbers.js';
import { enAdmin } from './en-admin.js';
import { enApiKeys } from './en-api-keys.js';

const SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

const PARKED_COPY_LITERAL =
  'Parked — not connected. This number is not receiving messages while parked. Messages people send you during this time may not appear after you reconnect. Queued messages are safe and will send when you reconnect.';

export const en = {
  'app.name': 'WA Automation by Sandbee',

  'nav.dashboard': 'Dashboard',
  'nav.instances': 'Numbers',
  'nav.unresolved': 'Unresolved sends',
  'nav.logout': 'Log out',
  'nav.language': 'Language',

  'realtime.live': 'Live',
  'realtime.reconnecting': 'Reconnecting…',
  'realtime.offline': 'Offline',

  'dashboard.title': 'Dashboard',
  'dashboard.subtitle': 'An overview of your connected WhatsApp numbers.',
  'dashboard.connectedNumbers': 'Connected numbers',
  'dashboard.queued': 'Queued',
  'dashboard.sent': 'Sent',
  'dashboard.empty.title': 'No numbers connected yet',
  'dashboard.empty.body':
    'You have 0 connected numbers, 0 messages queued, and 0 sent. Connect a number to get started.',
  'dashboard.empty.cta': 'Connect a number',

  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.error.generic': 'Something went wrong. Please try again.',
  'common.close': 'Close',

  'auth.recovery.title': 'Account recovery',
  'auth.recovery.code': 'Recovery code',
  'auth.recovery.submit': 'Continue',
  'auth.recovery.hint': 'Enter the recovery code for {name}.',
  'auth.recovery.invalid': 'That recovery code is not valid.',
  'auth.recovery.link': 'Need help recovering your account?',

  'instances.connect.title': 'Connect a number',
  'instances.connect.description':
    'Link a WhatsApp number to WP using a QR code or an 8-character pairing code.',
  'instances.connect.labelInput': 'Label',
  'instances.connect.labelInput.description': 'A name to tell this number apart from others.',
  'instances.connect.labelInput.placeholder': 'e.g. Sales team',
  'instances.connect.createButton': 'Continue',
  'instances.connect.methodTitle': 'Choose how to link',
  'instances.connect.methodQr': 'Scan a QR code',
  'instances.connect.methodCode': 'Enter an 8-character code',
  'instances.connect.phoneInput': 'Phone number',
  'instances.connect.phoneInput.description': 'Include the country code, e.g. +91XXXXXXXXXX.',
  'instances.connect.startButton': 'Start',
  'instances.connect.genericError': 'Something went wrong. Please try again.',

  'instances.connect.qr.title': 'Scan this QR code',
  'instances.connect.qr.body': 'Open WhatsApp on your phone, go to Linked Devices, and scan.',
  'instances.connect.qr.attemptsLeft': '{count} scans left',
  'instances.connect.qr.expired': 'This code has expired.',
  'instances.connect.qr.refreshButton': 'Generate a new code',

  'instances.connect.code.title': 'Enter this code in WhatsApp',
  'instances.connect.code.body':
    'Open WhatsApp on your phone, go to Linked Devices, Link with phone number, and enter this code.',
  'instances.connect.code.attemptsLeft': '{count} attempts left',
  'instances.connect.code.expired': 'This code has expired.',
  'instances.connect.code.refreshButton': 'Generate a new code',

  'instances.connect.connected.title': 'Connected',
  'instances.connect.connected.body': 'This number is linked and ready.',

  'instances.connect.parked.title': 'Parked',
  'instances.connect.parked.onlineButton': 'Bring online',
  'instances.connect.parked.parkButton': 'Park this number',

  'instances.connect.noFreeSlot.title': 'No free connected slot',
  'instances.connect.noFreeSlot.body':
    'All of your connected slots are in use. Park one of the numbers below to free a slot.',
  'instances.connect.noFreeSlot.parkInsteadButton': 'Park this one instead',

  'instances.connect.registeredLimitReached':
    'You have reached the number of numbers you can register. Contact support to add more.',
  'instances.connect.invalidState': 'This number cannot be linked right now. Please try again.',

  'instances.list.title': 'Numbers',
  'instances.list.subtitle': 'Connect and manage your WhatsApp numbers.',
  'instances.list.connectCta': 'Connect a number',

  'messages.compose.title': 'Send a message',
  'messages.compose.accountLabel': 'From number',
  'messages.compose.accountDescription': "The connected number's instance id.",
  'messages.compose.accountPlaceholder': 'Instance id',
  'messages.compose.recipientLabel': 'To',
  'messages.compose.recipientDescription': 'A phone number in +countrycode format, or a group.',
  'messages.compose.recipientPlaceholder': '+919876543210',
  'messages.compose.bodyLabel': 'Message',
  'messages.compose.bodyPlaceholder': 'Type your message',
  'messages.compose.sendButton': 'Send',
  'messages.compose.errorIdempotencyKeyReused':
    'This message was already submitted with different details. Please start a new message.',
  'messages.compose.errorInstanceUnlinked':
    'This number has not been linked yet. Connect it before sending.',
  'messages.compose.errorGeneric': 'Something went wrong. Please try again.',
  'messages.status.sent': 'Sent',

  'unresolved.panel.title': 'Unresolved sends',
  'unresolved.panel.empty': 'No unresolved sends for this number.',
  'unresolved.panel.error': 'Something went wrong. Please try again.',

  'pacing.fanoutBanner.title': 'Confirm duplicate-looking messages',
  'pacing.fanoutBanner.body':
    'This exact message is headed to {count} recipients today. It is queued and paused so you can confirm this is intended - nothing has failed or been lost.',
  'pacing.fanoutBanner.confirmButton': 'Yes, this is intended for {count} recipients',
  'pacing.fanoutBanner.editHint': 'Or edit the campaign if this was not intended.',
  'pacing.fanoutBanner.error': 'Something went wrong. Please try again.',

  'nav.settings': 'Settings',

  'webhooks.title': 'Webhook endpoints',
  'webhooks.subtitle':
    'Delivery is at-least-once. Your endpoint may receive the same event more than once - dedupe using the X-WP-Event-Id header.',
  'webhooks.empty.title': 'No webhook endpoints yet',
  'webhooks.empty.body': 'Add an endpoint to receive event notifications as state hints.',
  'webhooks.addButton': 'Add endpoint',
  'webhooks.loading': 'Loading…',
  'webhooks.error': 'Something went wrong. Please try again.',
  'webhooks.list.disabledBadge': 'Disabled',
  'webhooks.list.enabledBadge': 'Enabled',
  'webhooks.list.testButton': 'Send test event',
  'webhooks.list.testSending': 'Sending…',
  'webhooks.list.testResultSuccess': 'Test event queued for delivery.',
  'webhooks.list.testResultError': 'Could not queue the test event. Please try again.',
  'webhooks.list.deleteButton': 'Delete',
  'webhooks.list.deleteConfirmPrompt': 'Delete this endpoint? This cannot be undone.',
  'webhooks.list.deleteConfirmButton': 'Confirm delete',
  'webhooks.list.deleteCancelButton': 'Cancel',
  'webhooks.list.deleteError': 'Could not delete this endpoint. Please try again.',

  'webhooks.form.title': 'Add a webhook endpoint',
  'webhooks.form.urlLabel': 'Endpoint URL',
  'webhooks.form.urlDescription': 'Must be an HTTPS URL that can receive a POST request.',
  'webhooks.form.urlPlaceholder': 'https://example.com/webhooks/wp',
  'webhooks.form.eventsLabel': 'Events to send',
  'webhooks.form.deliveryNotice':
    'Delivery is at-least-once: your endpoint may receive the same event more than once. Dedupe using the X-WP-Event-Id header on each request.',
  'webhooks.form.sseHint':
    'The in-app realtime connection is a state hint, not an event log - it tells the panel something changed so it can refetch, and never replaces a webhook delivery.',
  'webhooks.form.submitButton': 'Create endpoint',
  'webhooks.form.genericError': 'Something went wrong. Please try again.',
  'webhooks.form.urlRequired': 'Enter a valid HTTPS endpoint URL.',
  'webhooks.form.eventsRequired': 'Choose at least one event.',

  'webhooks.secretOnce.title': 'Save this signing secret now',
  'webhooks.secretOnce.body':
    'This secret is shown once and will not be shown again. Store it before closing this dialog.',
  'webhooks.secretOnce.copyButton': 'Copy secret',
  'webhooks.secretOnce.copiedLabel': 'Copied',
  'webhooks.secretOnce.doneButton': 'Done',

  'webhooks.disabledBanner.title': 'This endpoint is disabled',
  'webhooks.disabledBanner.consecutiveFailures':
    'It was disabled after 20 consecutive delivery failures. Fix the endpoint, then re-enable it to resume delivery.',
  'webhooks.disabledBanner.generic': 'This endpoint is currently disabled.',
  'webhooks.disabledBanner.reEnableButton': 'Re-enable',
  'webhooks.disabledBanner.reEnableError': 'Could not re-enable this endpoint. Please try again.',

  'notifications.bell.label': 'Notifications',
  'notifications.bell.title': 'Notifications',
  'notifications.bell.empty': 'No notifications yet.',
  'notifications.bell.error': 'Something went wrong. Please try again.',
  'notifications.bell.markAllRead': 'Mark all read',
  'notifications.bell.markRead': 'Mark read',
  'notifications.bell.unreadBadge': 'Unread',
  'notifications.bell.loadMore': 'Load more',
  'notifications.bell.markReadError': 'Could not mark this as read. Please try again.',
  'notifications.banner.criticalBadge': 'Action needed',
  'notifications.banner.dismiss': 'Mark read',

  'wallet.empty.banner':
    'Sending paused — your wallet is empty. {queued} messages are waiting and will be sent ' +
    'as soon as you add funds.',
  'wallet.low.banner':
    'Your wallet balance is running low. Add funds soon to avoid an interruption.',
  'wallet.resume.afterTopup':
    'Sending resumes automatically once funds are added — most numbers pick back up within ' +
    'about a minute (the safety check that catches a missed signal runs on its own short ' +
    'cycle), never instantly.',
  'wallet.topup.formTitle': 'Add funds',
  'wallet.topup.amountLabel': 'Amount (INR)',
  'wallet.topup.methodLabel': 'Payment method',
  'wallet.topup.utrLabel': 'UTR / reference number',
  'wallet.topup.submitButton': 'Submit top-up request',
  'wallet.topup.duplicateError': 'This reference number has already been submitted.',
  'wallet.topup.genericError': 'Something went wrong. Please try again.',
  'wallet.topup.statusPending': 'Pending review',
  'wallet.topup.statusApproved': 'Approved',
  'wallet.topup.statusRejected': 'Rejected',

  'queueStatus.title': 'Queue status',
  'queueStatus.waiting': 'Waiting',
  'queueStatus.sentToday': 'Sent today',
  'queueStatus.failedToday': 'Failed today',

  'instances.card.safeModeStatus': 'Safe Mode: {profile} · Warm-up {tier} of 6 (day {day})',
  'instances.card.safeModeDisclaimer': SAFE_MODE_DISCLAIMER_LITERAL,
  'instances.card.pacingProfileName': 'Safe Mode (default)',
  'instances.card.todayProgress': 'Today {sent}/{cap}',
  'instances.card.newConversations': 'New conversations {count}/{cap}',
  'instances.card.nextSendEarliest': 'Next send earliest in {seconds}s',
  'instances.card.sendingWindow': 'Sending window {start}–{end} {tz}',
  'instances.card.notSending':
    'Not sending right now. The time shown is the earliest sending could resume, not a ' +
    'guaranteed time — it depends on this number staying healthy and connected.',
  'instances.card.health': 'Health {score}/100 {band}',
  'instances.card.healthWhyLink': 'why?',
  'instances.card.queueSummary': 'Queued {count} · oldest {age} · last send {lastSend}',
  'instances.card.queueDepthCapped': '10,000+',
  'instances.card.parked': PARKED_COPY_LITERAL,

  'instances.whyDrawer.title': 'Why this health score?',
  'instances.whyDrawer.signalNotScored':
    'Observed but not scored in v1 — shown for transparency, costing 0 points.',
  'instances.whyDrawer.signalNotEnoughData': 'Not enough data yet — this is not a penalty.',
  'instances.whyDrawer.window': 'Window {window}',
  'instances.whyDrawer.evidenceCount': '{count} data points',
  'instances.whyDrawer.pointsCost': '{points} pts',
  'instances.whyDrawer.timelineTitle': 'Timeline',

  'instances.needsAction.title': 'Action needed',
  'instances.needsAction.openPanelSection': 'Open number details',
  'instances.needsAction.reconnect': 'Reconnect',
  'instances.needsAction.acknowledge': 'Acknowledge',

  'inbound.shed.notice':
    'High inbound volume on this number — some incoming messages are not being checked for ' +
    'opt-out keywords right now, up to the per-number limit. Delivery receipts are still being ' +
    'recorded as they arrive; WhatsApp does not guarantee that every receipt reaches a linked ' +
    'device. Queued messages are safe.',

  ...enContacts,
  ...enBroadcasts,
  ...enGroups,
  ...enShell,
  ...enInstancesUi,
  ...enMessagingUi,
  ...enDataUi,
  ...enDashboard,
  ...enOnboarding,
  ...enShellRefresh,
  ...enNumbers,
  ...enAdmin,
  ...enApiKeys,
} as const satisfies Catalogue;
