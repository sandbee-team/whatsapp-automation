import type { NotificationEmailCopy } from './notifications.js';

/**
 * Split out of `notifications.ts` (P28 U1, to stay under the `max-lines: 300`
 * cap - same "move a self-contained per-kind copy block to a sibling module"
 * idiom `enums/p28-admin.ts` already established) - staff-action / admin-
 * visible notification copy. `client_suspended`/`wallet_frozen` state
 * plainly this is OUR action (WP support), never a WhatsApp restriction,
 * ban or block (invariant 6 / safety-compliance); `impersonation_started`/
 * `impersonation_body_access` are the client's own visible record of a
 * time-limited support access grant. No delivery-speed or capacity figures
 * anywhere below. Merged into `NOTIFICATION_COPY` via object spread in
 * `notifications.ts` so `satisfies Record<NotificationKind, ...>` still
 * covers every key from one place.
 */

interface AdminCopyEntry {
  readonly title: string;
  readonly email: NotificationEmailCopy;
}

function withTail(body: string): string {
  const PANEL_TAIL_LINE =
    'Open the WP panel for details and history — further alerts this hour may be summarised there.';
  return `${body} ${PANEL_TAIL_LINE}`;
}

export const NOTIFICATION_COPY_P28_ADMIN = {
  client_suspended: {
    title: 'Sending suspended by WP support',
    email: {
      subject: 'Sending suspended on your WP account',
      body: withTail(
        'Sending is suspended by WP support. Your queued messages are preserved. Contact ' +
          'support for details on what is needed to resume.',
      ),
    },
  },
  client_reactivated: {
    title: 'Sending resumed',
    email: {
      subject: 'Sending resumed on your WP account',
      body: withTail(
        'WP support has lifted the suspension on your account. Your queued messages will ' +
          'resume sending on their normal schedule.',
      ),
    },
  },
  wallet_frozen: {
    title: 'Wallet on hold by WP support',
    email: {
      subject: 'Your WP wallet is on hold',
      body: withTail(
        'WP support has placed a billing/account-review hold on your wallet. Funds you add ' +
          'still land in your balance, but sending resumes only once support lifts the hold — ' +
          'this is not a WhatsApp restriction.',
      ),
    },
  },
  wallet_unfrozen: {
    title: 'Wallet hold lifted',
    email: {
      subject: 'Your WP wallet hold has been lifted',
      body: withTail(
        'WP support has lifted the hold on your wallet. Sending resumes on its normal schedule, ' +
          'subject to your available balance.',
      ),
    },
  },
  wallet_credited_by_staff: {
    title: 'Wallet credited by WP support',
    email: {
      subject: 'Your WP wallet was credited',
      body: withTail(
        'WP support added funds to your wallet balance. Check the panel for the amount and reason.',
      ),
    },
  },
  topup_rejected: {
    title: 'Top-up not approved',
    email: {
      subject: 'Your WP top-up submission was not approved',
      body: withTail(
        'WP support could not approve your recent top-up submission. Check the panel for the ' +
          'reason and resubmit with corrected details.',
      ),
    },
  },
  limits_changed: {
    title: 'Account limits changed',
    email: {
      subject: 'Your WP account limits changed',
      body: withTail(
        'WP support changed one or more of your account limits. Check the panel for the new values.',
      ),
    },
  },
  pricing_changed: {
    title: 'Pricing updated',
    email: {
      subject: 'Your WP account pricing was updated',
      body: withTail(
        'WP support updated the pricing on your account. Check the panel for the new rates.',
      ),
    },
  },
  pacing_relaxed: {
    title: 'Pacing relaxed by WP support',
    email: {
      subject: 'Pacing limits relaxed on {instanceLabel}',
      body: withTail(
        'WP support temporarily relaxed the pacing limits on {instanceLabel}. This is a support ' +
          'adjustment, not a change to your plan.',
      ),
    },
  },
  instance_paused_by_staff: {
    title: 'Number paused by WP support',
    email: {
      subject: '{instanceLabel} was paused by WP support',
      body: withTail(
        'WP support paused sending on {instanceLabel}. Your {queued} queued messages are ' +
          'preserved and will send once support resumes the number.',
      ),
    },
  },
  instance_resumed_by_staff: {
    title: 'Number resumed by WP support',
    email: {
      subject: '{instanceLabel} was resumed by WP support',
      body: withTail(
        'WP support resumed sending on {instanceLabel}. Your queued messages will send on ' +
          'their normal schedule.',
      ),
    },
  },
  campaign_cancelled_by_staff: {
    title: 'Campaign cancelled by WP support',
    email: {
      subject: 'A campaign was cancelled by WP support',
      body: withTail(
        'WP support cancelled a campaign on your account. Check the panel for the reason. Any ' +
          'messages already sent are unaffected.',
      ),
    },
  },
  impersonation_started: {
    title: 'WP support accessed your workspace',
    email: {
      subject: 'WP support opened a session in your workspace',
      body: withTail(
        'A named WP support session was opened in your workspace for a stated reason. It is ' +
          'time-limited (30 minutes or less) and sees account metadata only — never your message ' +
          'content — unless a separate elevation is granted. This notification is the record of ' +
          'that access.',
      ),
    },
  },
  impersonation_body_access: {
    title: 'WP support granted access to message content',
    email: {
      subject: 'WP support was granted access to your message content',
      body: withTail(
        'WP support was granted time-limited access (15 minutes or less) to message content in ' +
          'your workspace for the stated reason. This notification is the record of that access.',
      ),
    },
  },
} satisfies Record<string, AdminCopyEntry>;
