import type { NotificationKind } from '../enums/index.js';
import { PACING_COPY } from './pacing-copy.js';
import { INFRA_UNAVAILABLE_COPY } from './infra-unavailable-copy.js';
import { NOTIFICATION_COPY_P28_ADMIN } from './notifications-p28-admin.js';

/**
 * copy/notifications.ts (P17 Unit U2, step 2) - verbatim user-facing copy
 * for every `NotificationKind` row: an email `{subject, body}` (English v1,
 * `{brace}` placeholders) plus a short in-app `title`. Total over
 * `NotificationKind` - `satisfies Record<NotificationKind, ...>` makes a
 * missing kind a type error.
 *
 * Pause bodies REUSE `PACING_COPY.instancePausedRestriction` (the only
 * pause-body string `pacing-copy.ts` currently exports - read that file
 * before adding a second one) rather than restating the wording; `infra_
 * unavailable` reuses `INFRA_UNAVAILABLE_COPY` verbatim. Every email body
 * ends with `PANEL_TAIL_LINE`, pointing the reader at the panel for detail
 * and history.
 *
 * `scripts/check-copy.ts` scans this file too (clause (a) banned-claims) -
 * no string here promises prevention of a WhatsApp restriction (invariant
 * 6).
 */

const PANEL_TAIL_LINE =
  'Open the WP panel for details and history — further alerts this hour may be summarised there.';

export interface NotificationEmailCopy {
  readonly subject: string;
  readonly body: string;
}

export interface NotificationCopyEntry {
  readonly title: string;
  readonly email: NotificationEmailCopy;
}

function withTail(body: string): string {
  return `${body} ${PANEL_TAIL_LINE}`;
}

export const NOTIFICATION_COPY = {
  instance_paused: {
    title: 'Sending paused',
    email: {
      subject: 'Sending paused on {instanceLabel}',
      body: withTail(PACING_COPY.instancePausedRestriction),
    },
  },
  instance_logged_out: {
    title: 'Number logged out',
    email: {
      subject: '{instanceLabel} was logged out of WhatsApp',
      body: withTail(
        'This number was logged out of WhatsApp and needs to be relinked before sending can ' +
          'resume. Your {queued} queued messages are preserved and will send once you relink.',
      ),
    },
  },
  reconnect_budget_exhausted: {
    title: 'Reconnect attempts exhausted',
    email: {
      subject: '{instanceLabel} could not reconnect',
      body: withTail(
        'We stopped trying to reconnect {instanceLabel} after repeated failed attempts. Your ' +
          '{queued} queued messages are preserved. Please relink the number to resume sending.',
      ),
    },
  },
  duplicate_fanout_ack_required: {
    title: 'Duplicate check needed',
    email: {
      subject: 'A queued message needs a duplicate check',
      body: withTail(
        'A message could not be confirmed as sent before the connection dropped. Choose Retry ' +
          '(may duplicate) or Discard (may have been delivered) in the panel to resolve it.',
      ),
    },
  },
  unresolved_send: {
    title: 'Unresolved send needs a decision',
    email: {
      subject: 'A message needs your decision',
      body: withTail(
        'We could not confirm delivery of a queued message. Choose Retry (may duplicate) or ' +
          'Discard (may have been delivered) in the panel to resolve it.',
      ),
    },
  },
  plan_cap_reached: {
    title: 'Plan cap reached',
    email: {
      subject: '{instanceLabel} reached its plan cap for today',
      body: withTail(
        'This number reached its plan-cap limit for today. Remaining messages stay queued and ' +
          'will send once the cap resets or your plan changes.',
      ),
    },
  },
  infra_unavailable: {
    title: 'Connection unavailable',
    email: {
      subject: '{instanceLabel} could not stay connected',
      body: withTail(INFRA_UNAVAILABLE_COPY),
    },
  },
  warmup_tier_changed: {
    title: 'Warm-up tier changed',
    email: {
      subject: '{instanceLabel} moved to a new warm-up tier',
      body: withTail(
        'This number moved to Warm-up tier {tier}, day {day}. Today’s sending limits have ' +
          'changed accordingly.',
      ),
    },
  },
  // P19 Unit U4 (step 6) - wallet state copy. Both bodies say plainly this
  // is OUR billing stop, never that WhatsApp restricted the number (core
  // invariant 6 / safety-compliance) - and never a delivery-speed promise:
  // resume happens on the account's own next eligible claim once funds are
  // added, stated honestly with no "instant"/"≤5s" figure.
  wallet_low: {
    title: 'Wallet balance low',
    email: {
      subject: 'Your WP wallet balance is running low',
      body: withTail(
        'Your WP wallet balance is running low. Add funds soon to avoid an interruption to ' +
          'sending — this is a billing balance, not a WhatsApp restriction.',
      ),
    },
  },
  wallet_empty: {
    title: 'Sending paused — wallet empty',
    email: {
      subject: 'Sending paused on your WP account — wallet is empty',
      body: withTail(
        'Sending paused — your wallet is empty. This is our billing stop, not a WhatsApp ' +
          'restriction. Your {queued} queued messages are preserved and will be sent as soon ' +
          'as you add funds.',
      ),
    },
  },
  // P24 (groups-messaging) Unit U1 - a send into a group came back
  // forbidden. States plainly this is a group-membership/permission signal,
  // never a claim that pacing prevents a WhatsApp restriction (invariant 6).
  group_forbidden: {
    title: 'Group sending disabled',
    email: {
      subject: 'Sending to a group on {instanceLabel} was disabled',
      body: withTail(
        'We could not send to one of your groups on {instanceLabel} — it looks like the group ' +
          'was left, removed, or restricted to admins only. Sending to that group has been ' +
          'disabled; other queued messages are unaffected.',
      ),
    },
  },
  // P25 observability-and-runbook Unit U3 - an honest, non-alarmist opt-out
  // rate signal: never a claim about WhatsApp outcomes, never threat
  // wording (invariant 6 / safety-compliance).
  optout_rate_high: {
    title: 'Opt-out rate is high',
    email: {
      subject: 'More recipients than usual opted out of your messages',
      body: withTail(
        'The share of recipients replying STOP in the last 24 hours is well above normal. ' +
          'This usually means recipients did not expect these messages, or the content or ' +
          'frequency needs a change — review your audience and consent basis before sending more.',
      ),
    },
  },
  // P28 (admin-internal-api-and-panel) Unit U1 - staff-action / admin-
  // visible notification copy. Split out to `./notifications-p28-admin.js`
  // (file-length cap) and spread back in here so `satisfies Record<
  // NotificationKind, ...>` still covers every key from this one object.
  ...NOTIFICATION_COPY_P28_ADMIN,
} satisfies Record<NotificationKind, NotificationCopyEntry>;

export type NotificationCopy = typeof NOTIFICATION_COPY;
