import { NOTIFICATION_KINDS } from '../enums/index.js';
import type { NotificationKind, NotificationSeverity } from '../enums/index.js';

/**
 * notifications/kinds.ts (P17 Unit U2, step 2) - the kind registry: per
 * `NotificationKind`, its `severity`, its OUTBOX fanout `channels` (migration
 * 0048 extended the outbox constraint to allow `'email'` alongside `'sse'` /
 * `'webhook'`), whether it is `mandatory` (no code path may ever turn off a
 * mandatory kind's channels), and its `dedupeScope` (see `dedupe-key.ts`).
 *
 * The six blueprint-mandatory kinds (`instance_paused`, `instance_logged_out`,
 * `reconnect_budget_exhausted`, `duplicate_fanout_ack_required`,
 * `unresolved_send`, `plan_cap_reached`) are ALL `mandatory: true` with the
 * full `['sse', 'email', 'webhook']` fanout - there is no suppression path
 * for any of them, by construction: this module exports no function that
 * could remove a channel, and the registry (and every entry/channels array
 * inside it) is deeply frozen so a caller cannot mutate one into existence
 * either (`notification-kinds.test.ts`'s
 * `every_mandatory_blueprint_kind_is_registered_and_not_suppressible`
 * asserts `Object.isFrozen` at both levels).
 *
 * `satisfies Record<NotificationKind, ...>` makes a missing key (a kind
 * registered in `NOTIFICATION_KINDS` but never mapped here) a TYPE ERROR,
 * not a silent runtime gap.
 */

export type NotificationChannel = 'sse' | 'email' | 'webhook';

export type NotificationDedupeScope = 'transition' | 'instance-day';

export interface NotificationKindEntry {
  readonly severity: NotificationSeverity;
  readonly channels: readonly NotificationChannel[];
  readonly mandatory: boolean;
  readonly dedupeScope: NotificationDedupeScope;
}

const MANDATORY_ALL_CHANNELS = Object.freeze(['sse', 'email', 'webhook'] as const);

const REGISTRY_SOURCE = {
  instance_paused: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'transition',
  },
  instance_logged_out: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'transition',
  },
  reconnect_budget_exhausted: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'transition',
  },
  duplicate_fanout_ack_required: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'transition',
  },
  unresolved_send: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'transition',
  },
  // 'instance-day' dedupe scope: a genuinely repeating daily condition
  // (design canon) - see dedupe-key.ts's own doc comment. `wallet_low`
  // below (P19 Unit U4) is the only other kind with this scope.
  plan_cap_reached: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: true,
    dedupeScope: 'instance-day',
  },
  infra_unavailable: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  warmup_tier_changed: {
    severity: 'info',
    channels: Object.freeze(['sse'] as const),
    mandatory: false,
    dedupeScope: 'transition',
  },
  // P19 Unit U4 (step 6) - wallet state notifications. Both non-mandatory
  // (a client with mandatory notifications suppressed still gets these -
  // wallet is not one of the six blueprint-mandatory kinds), full
  // sse/email/webhook fanout. `wallet_low` is the only OTHER
  // 'instance-day'-scoped kind besides `plan_cap_reached` - see
  // `state-notifier.ts`'s own header for how its {client}/{yyyy-mm-dd}
  // dedupe key maps onto this scope (bucket = the tenant-local date,
  // transitionId = the client id, no instanceId - wallet is client-level).
  // `wallet_empty` uses 'transition' - its transitionId is the client's own
  // `last_empty_at` stamp (a real transition identity), never a wall clock.
  wallet_low: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'instance-day',
  },
  wallet_empty: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  // P24 (groups-messaging) Unit U1 - a send into a group came back
  // forbidden (group left/removed/announce-only against our role). Not one
  // of the six blueprint-mandatory kinds. 'transition' dedupe scope: one
  // notification per (kind, instance, transitionId=group id) - a repeat
  // forbidden signal for the SAME group is the same transition, not a new
  // daily occurrence (unlike wallet_low/plan_cap_reached).
  group_forbidden: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  // P25 observability-and-runbook Unit U3 - a client's trailing-24h opt-out
  // rate crossed the per-client threshold (a content problem, not a
  // WhatsApp restriction). Client-level like `wallet_low`: 'instance-day'
  // dedupe scope, bucket = the UTC calendar date, transitionId = the client
  // id, no instanceId.
  optout_rate_high: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'instance-day',
  },
  // P28 (admin-internal-api-and-panel) Unit U1 - staff-action / admin-
  // visible notification kinds. All non-mandatory, all 'transition' dedupe
  // scope: transitionId is always a real transition identity (the
  // staff_audit_log row id or the impersonation_grants row id), never a
  // wall clock. Full sse/email/webhook fanout for a suspension/freeze/pause
  // or an impersonation event (client must always learn about these);
  // sse+webhook only for the three lower-stakes config-change kinds.
  client_suspended: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  client_reactivated: {
    severity: 'info',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  wallet_frozen: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  wallet_unfrozen: {
    severity: 'info',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  wallet_credited_by_staff: {
    severity: 'info',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  topup_rejected: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  limits_changed: {
    severity: 'info',
    channels: Object.freeze(['sse', 'webhook'] as const),
    mandatory: false,
    dedupeScope: 'transition',
  },
  pricing_changed: {
    severity: 'warning',
    channels: Object.freeze(['sse', 'webhook'] as const),
    mandatory: false,
    dedupeScope: 'transition',
  },
  pacing_relaxed: {
    severity: 'info',
    channels: Object.freeze(['sse', 'webhook'] as const),
    mandatory: false,
    dedupeScope: 'transition',
  },
  instance_paused_by_staff: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  instance_resumed_by_staff: {
    severity: 'info',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  campaign_cancelled_by_staff: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  impersonation_started: {
    severity: 'warning',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
  impersonation_body_access: {
    severity: 'critical',
    channels: MANDATORY_ALL_CHANNELS,
    mandatory: false,
    dedupeScope: 'transition',
  },
} satisfies Record<NotificationKind, NotificationKindEntry>;

/**
 * Deep-frozen so no caller can mutate a mandatory kind's channels into a
 * suppressed shape at runtime - see this module's own header.
 */
export const NOTIFICATION_KIND_REGISTRY: Record<NotificationKind, NotificationKindEntry> =
  Object.freeze(
    Object.fromEntries(
      NOTIFICATION_KINDS.map((kind) => [kind, Object.freeze({ ...REGISTRY_SOURCE[kind] })]),
    ),
  ) as unknown as Record<NotificationKind, NotificationKindEntry>;
