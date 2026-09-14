/**
 * en-groups.ts (P24 groups-messaging, Unit U2, step 5) - the `groups.*`/
 * `broadcasts.targetKind.*` English keys, split out of `en.ts` (same
 * `max-lines: 300` split idiom as `en-broadcasts.ts`/`en-contacts.ts`).
 * Spread into `en.ts`'s default export; `hi-groups.ts` is the matching
 * Hindi sibling.
 *
 * `groups.disclosure` is BYTE-IDENTICAL to `@wp/domain`'s
 * `GROUP_RISK_DISCLOSURE` - `catalogue-copy-parity.test.ts` proves it.
 */

/**
 * Byte-identical COPY of `@wp/domain`'s `GROUP_RISK_DISCLOSURE` (never a
 * re-export - `@wp/i18n` has zero dependencies, ADR 0007), same idiom as
 * `en-broadcasts.ts`'s own `BROADCAST_DISCLOSURE_LITERAL`. A template
 * literal (not single-quoted) so this file's raw source text is
 * byte-for-byte identical to the constant's runtime value.
 */
const GROUP_RISK_DISCLOSURE_LITERAL = `Sending promotional messages into WhatsApp groups is one of the highest report-rate behaviours on the platform. A single annoyed member can report the message, and group reports are visible to WhatsApp in a way one-to-one messages are not. WP caps group sending, disables it during warm-up, and switches it off first when your account's health signals worsen — but a group blast is riskier than the same message sent one-to-one, and no pacing changes that.`;

export const enGroups = {
  'nav.groups': 'Groups',

  'groups.title': 'Groups',
  'groups.subtitle':
    'Send to WhatsApp groups this number is already in. Group sending is riskier than the ' +
    'same message sent one-to-one.',
  'groups.disclosure': GROUP_RISK_DISCLOSURE_LITERAL,

  'groups.list.empty': 'No groups synced yet for this number.',
  'groups.subject.fallback': 'Untitled group',
  'groups.list.syncNow': 'Sync groups',
  'groups.list.syncRequested':
    'Sync requested. Groups refresh within a minute while this number is connected.',
  'groups.list.syncRateLimited':
    'Groups were synced less than an hour ago. Next sync available at {time}.',
  'groups.list.lastSynced': 'Last synced {time}',
  'groups.list.neverSynced': 'Never synced',
  'groups.column.subject': 'Group',
  'groups.column.participants': 'Members',
  'groups.column.role': 'Your role',
  'groups.column.status': 'Sending',

  'groups.role.member': 'Member',
  'groups.role.admin': 'Admin',
  'groups.role.superadmin': 'Owner',

  'groups.status.enabled': 'On',
  'groups.status.disabled': 'Off',

  'groups.reason.NOT_SEND_ENABLED': 'Sending is off for this group.',
  'groups.reason.ANNOUNCE_MEMBER_ONLY':
    'Announcement group: only admins can post, and this number is a member.',
  'groups.reason.GROUP_CAP_ZERO_AT_TIER': 'Group sending is off at your current warm-up tier.',
  'groups.reason.DEVICE_BUDGET_EXCEEDED':
    "Enabling this group would exceed this number's group-member device budget ({total} of " +
    '{max} in use).',
  'groups.reason.group_forbidden':
    'WhatsApp refused a send to this group (not an admin, announcement-only, or no longer a ' +
    'member). Sending was switched off for this group only.',
  'groups.reason.leave_requested': 'Leaving this group.',
  'groups.reason.not_participant': 'This number is no longer in the group.',
  'groups.reason.generic': 'Sending is off for this group.',

  'groups.instancePicker.label': 'Number',
  'groups.instancePicker.placeholder': 'Choose a number',

  'groups.enable.title': 'Turn on sending to this group?',
  'groups.enable.reach': '~{count} people will see this.',
  'groups.enable.confirm': 'Turn on',
  'groups.enable.cancel': 'Cancel',
  'groups.disable.confirm': 'Turn off',

  'groups.leave.title': 'Leave this group?',
  'groups.leave.body':
    'Leaving is always allowed. Queued messages to this group will fail once the number has ' +
    'left.',
  'groups.leave.confirm': 'Leave group',

  'groups.cap.today': 'Group sends today: {sent} of {cap}',
  'groups.cap.remaining': '{remaining} group sends left today',
  'groups.cap.offAtTier': 'Group sending is off at your current warm-up tier.',

  'groups.budget.line': 'Tracked member devices: {total} of {max}',
  'groups.budget.derivedNote': 'Estimated from member counts, not measured.',

  'groups.optout.unattributableWarning':
    'An opt-out keyword sent from inside a group may not be attributable to a specific contact.',

  'groups.notification.group_forbidden.title': 'Group sending switched off',
  'groups.notification.group_forbidden.body':
    'WhatsApp refused a send to one group. Sending was switched off for that group only; this ' +
    'number keeps sending.',

  'broadcasts.targetKind.label': 'Send to',
  'broadcasts.targetKind.contacts': 'Contacts',
  'broadcasts.targetKind.groups': 'Groups',
  'broadcasts.composer.groupsAllEnabled': 'All groups with sending on will receive this.',
  'broadcasts.composer.groupsSelectedCount': '{count} groups selected',

  'groups.preflight.reach': 'Approximate reach: ~{count} people across {groups} groups',
  'groups.preflight.capLine': 'Group cap today: {remaining} of {cap} remaining',
  'groups.preflight.offAtTier': 'group sending is off at your current warm-up tier',
  'groups.preflight.skipped': '{count} groups skipped ({reasons})',
} as const;
