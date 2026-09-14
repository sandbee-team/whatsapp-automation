/**
 * en-broadcasts.ts (P23a Unit U3, step 1) - the `broadcasts.*`/`nav.broadcasts`
 * English keys, split out of `en.ts` (that file sat near the `max-lines: 300`
 * cap - core-invariants.md's mandatory split idiom, sibling module rather
 * than trimming a contract/behaviour comment). Spread into `en.ts`'s default
 * export; `hi-broadcasts.ts` is the matching Hindi sibling, same idiom as
 * `en-contacts.ts`/`hi-contacts.ts`.
 *
 * `broadcasts.frequencyLine` is now BYTE-IDENTICAL to `@wp/domain`'s
 * `BROADCAST_FREQUENCY_NOTE` (em dash, not ` - `) and `broadcasts.estimateCaveat`
 * to `BROADCAST_ESTIMATE_CAVEAT` - `catalogue-copy-parity.test.ts` proves both.
 */

/**
 * P23 Unit U2 (step 3) - byte-identical COPY of `@wp/domain`'s
 * `BROADCAST_DISCLOSURE` (never a re-export - `@wp/i18n` has zero
 * dependencies, ADR 0007), same idiom as `SAFE_MODE_DISCLAIMER_LITERAL` in
 * `en.ts`. A template literal (not single-quoted) so this file's raw source
 * text is byte-for-byte identical to the constant's runtime value - the
 * text contains a literal `"Broadcast"` in double quotes.
 * `catalogue-copy-parity.test.ts` asserts this stays byte-identical to the
 * domain constant.
 */
const BROADCAST_DISCLOSURE_LITERAL = `What "Broadcast" means in WP. WhatsApp's own broadcast lists have a limitation most people discover the hard way: a broadcast-list message is only delivered to recipients who have already saved your number in their phone. Everyone else silently receives nothing. WP does not use broadcast lists. When you send a WP Broadcast, we create one individually-addressed message per recipient — the same thing as if you had opened each chat and typed it yourself — and we send them one at a time, paced, from your connected number. That is why a broadcast to 2,000 people takes hours or days rather than seconds: the pacing is the product. It also means each recipient sees a normal one-to-one message from you, can reply to it, and their reply lands in your Inbox. A Broadcast is not a licence to exceed your account's daily cap — it simply takes as long as your cap allows, and the panel shows you the honest estimated finish time before you start.`;

/**
 * `broadcasts.preflight.accountDetail` below names "Safe Mode" (the pacing
 * feature) - `scripts/check-copy.ts`'s co-presence clause (b) requires this
 * file to also carry `SAFE_MODE_DISCLAIMER` verbatim; byte-identical COPY of
 * `@wp/domain`'s `SAFE_MODE_DISCLAIMER` (never a re-export - `@wp/i18n` has
 * zero dependencies, ADR 0007), same idiom as `en.ts`'s own
 * `SAFE_MODE_DISCLAIMER_LITERAL`. Exported (not rendered by any component in
 * this feature) purely so the guard's plain substring match sees it and so
 * a drift-guard test can assert it stays byte-identical to the domain
 * constant, same idiom as `catalogue-copy-parity.test.ts`'s existing
 * assertions.
 */
export const BROADCAST_ACCOUNT_SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

export const enBroadcasts = {
  'nav.broadcasts': 'Broadcasts',
  'broadcasts.title': 'Broadcasts',

  'broadcasts.disclosure': BROADCAST_DISCLOSURE_LITERAL,
  'broadcasts.frequencyLine':
    'Sending the same audience from another number does not increase how often a person can ' +
    'be messaged — the frequency limit is per workspace.',
  'broadcasts.estimateCaveat': 'This is an estimate, not a guarantee.',
  'broadcasts.backpressure.holding': 'Queuing paused - {count} already waiting',
  'broadcasts.cancel.notRecalled': 'Messages already sent are not recalled and are not refunded.',
  'broadcasts.epoch.stranded':
    '{count} queued messages were created for the previous link of this number. Confirm the ' +
    'count to send them from the current link, or cancel them.',
  'broadcasts.limit.overPlan':
    'This audience ({count}) is over your plan limit ({limit}). Reduce the audience or ' +
    'contact us.',
  'broadcasts.limit.noPlan': 'No plan is attached to this workspace, so broadcasts cannot start.',

  'broadcasts.preflight.title': 'Review before you start',
  'broadcasts.preflight.audience': 'Audience',
  'broadcasts.preflight.contacts': '{count} contacts',
  'broadcasts.preflight.skipped': '{count} skipped: {reason}',
  'broadcasts.preflight.skipReason.opted_out': 'opted out',
  'broadcasts.preflight.skipReason.missing_var': 'missing variable {token}',
  'broadcasts.preflight.alreadyMessaged': 'Already messaged',
  'broadcasts.preflight.alreadyMessagedDetail':
    '{count} of these received a message from one of your numbers recently and will wait ' +
    'until that window expires (excluded from the estimate below)',
  'broadcasts.preflight.billable': 'Billable',
  'broadcasts.preflight.billableDetail': '{count} messages × {rate} = {total}',
  'broadcasts.preflight.wallet': 'Wallet balance',
  'broadcasts.preflight.walletDetail': '{balance} → after this broadcast ≈ {after}',
  'broadcasts.preflight.walletInsufficient':
    'Your wallet does not cover this broadcast. Sending pauses when the wallet empties; ' +
    'queued messages are kept and resume after a top-up.',
  'broadcasts.preflight.account': 'Account',
  'broadcasts.preflight.accountDetail':
    '{label} · Safe Mode tier {tier} · {cap}/day cap · {sent} already sent today',
  'broadcasts.preflight.estimate': 'Estimated finish',
  'broadcasts.preflight.estimateDays': 'about {days} days ({date})',
  'broadcasts.preflight.estimateToday': 'today ({date})',
  'broadcasts.preflight.estimateUnavailable':
    "No estimate: this number's daily cap is 0 right now.",
  'broadcasts.preflight.optionsIntro': 'To finish sooner you can:',
  'broadcasts.preflight.option.reduce_audience': 'reduce the audience',
  'broadcasts.preflight.option.wait_for_warm_up': 'wait for warm-up to raise the daily cap',
  'broadcasts.preflight.fanOutAck':
    'More than {threshold} recipients will get the same message today, so the messages queue ' +
    'behind a confirmation banner on the Numbers page until you acknowledge it.',
  'broadcasts.preflight.start': 'Start broadcast',
  'broadcasts.preflight.back': 'Back to editing',
  'broadcasts.preflight.starting': 'Starting…',
  'broadcasts.preflight.priceNote': "Prices are WP's per-message pricing.",

  'broadcasts.composer.title': 'New broadcast',
  'broadcasts.composer.nameLabel': 'Name',
  'broadcasts.composer.instanceLabel': 'Send from number',
  'broadcasts.composer.instanceOption': '{label} · tier {tier} · {cap}/day',
  'broadcasts.composer.audienceLabel': 'Audience',
  'broadcasts.composer.tagsLabel': 'Tags',
  'broadcasts.composer.contactSearchLabel': 'Add individual contacts',
  'broadcasts.composer.contactSearchPlaceholder': 'Search by name or number',
  'broadcasts.composer.search': 'Search',
  'broadcasts.composer.audienceSummary': '{tags} tags · {contacts} contacts selected',
  'broadcasts.composer.bodyLabel': 'Message',
  'broadcasts.composer.variablesLabel': 'Insert a variable',
  'broadcasts.composer.variablesHelp':
    'A contact missing a variable is skipped and never receives a message with a blank.',
  'broadcasts.composer.attrKeyPlaceholder': 'custom attribute key',
  'broadcasts.composer.attrKeyInvalid':
    'Attribute keys are lowercase letters, digits and underscores, starting with a letter.',
  'broadcasts.composer.insert': 'Insert',
  'broadcasts.composer.tokensInUse': 'Variables in this message: {tokens}',
  'broadcasts.composer.priorityLabel': 'Priority',
  'broadcasts.composer.priorityNote':
    'Priority orders your queue. It is not a delivery-speed guarantee and does not change ' +
    'your daily cap.',
  'broadcasts.composer.priority.high': 'High',
  'broadcasts.composer.priority.normal': 'Normal',
  'broadcasts.composer.priority.low': 'Low',
  'broadcasts.composer.scheduleLabel': 'Schedule (optional)',
  'broadcasts.composer.scheduleHelp':
    'Messages queue now and start sending at this time, within your sending window and cap.',
  'broadcasts.composer.reviewQuote': 'Review quote',
  'broadcasts.composer.quoting': 'Preparing your quote…',
  'broadcasts.composer.error.validation': 'Please complete every required field.',
  'broadcasts.composer.error.limit':
    "This audience is over your plan's broadcast limit. Reduce the audience or contact us.",
  'broadcasts.composer.error.conflict': 'This broadcast has already changed. Reload and try again.',
  'broadcasts.composer.error.generic': 'Something went wrong. Nothing was sent.',
  'broadcasts.composer.remove': 'Remove',

  'broadcasts.list.title': 'Broadcasts',
  'broadcasts.list.new': 'New broadcast',
  'broadcasts.list.empty': 'No broadcasts yet.',
  'broadcasts.list.loadMore': 'Load more',
  'broadcasts.list.col.name': 'Name',
  'broadcasts.list.col.status': 'Status',
  'broadcasts.list.col.audience': 'Audience',
  'broadcasts.list.col.quote': 'Quote',
  'broadcasts.list.col.created': 'Created',

  'broadcasts.status.draft': 'Draft',
  'broadcasts.status.scheduled': 'Scheduled',
  'broadcasts.status.snapshotting': 'Preparing audience',
  'broadcasts.status.expanding': 'Queuing',
  'broadcasts.status.running': 'Sending',
  'broadcasts.status.paused': 'Paused',
  'broadcasts.status.completed': 'Completed',
  'broadcasts.status.cancelled': 'Cancelled',
  'broadcasts.status.failed': 'Failed',

  'broadcasts.funnel.title': 'Progress',
  'broadcasts.funnel.total': 'Audience',
  'broadcasts.funnel.queued': 'Queued',
  'broadcasts.funnel.deferredOfWhich': '{count} of these are waiting for pacing',
  'broadcasts.funnel.sent': 'Sent',
  'broadcasts.funnel.delivered': 'Delivered',
  'broadcasts.funnel.read': 'Read',
  'broadcasts.funnel.skipped': 'Skipped',
  'broadcasts.funnel.failed': 'Failed',
  'broadcasts.funnel.cancelled': 'Cancelled',
  'broadcasts.funnel.charged': 'Charged so far: {amount}',
  'broadcasts.funnel.receiptsLowerBound':
    'Delivered and read counts are a lower bound: WhatsApp does not guarantee that every ' +
    'receipt reaches a linked device.',

  'broadcasts.detail.pause': 'Pause',
  'broadcasts.detail.resume': 'Resume',
  'broadcasts.detail.cancel': 'Cancel broadcast',
  'broadcasts.detail.pauseConfirm':
    'Pause this broadcast? Queued messages are kept and nothing more is sent until you resume.',
  'broadcasts.detail.resumeConfirm':
    'Resume sending? Messages continue under your daily cap and sending window.',
  'broadcasts.cancel.confirmBody': 'Cancel this broadcast? Queued messages will not be sent.',
  'broadcasts.detail.confirm': 'Confirm',
  'broadcasts.detail.back': 'Back',
  'broadcasts.detail.notFound': 'This broadcast does not exist or belongs to another workspace.',
  'broadcasts.detail.draftNote':
    'This broadcast has not started. Review the quote and start it from the composer.',
  'broadcasts.detail.sendingFrom': 'Sending from {label}',
  'broadcasts.detail.scheduledFor': 'Scheduled for {date}',
  'broadcasts.detail.createdAt': 'Created {date}',
} as const;
