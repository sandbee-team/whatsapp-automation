/**
 * @wp/domain - pure business logic: job/health FSMs, retry classifier, backoff math, fairness (DRR) math, safe-mode pacing math, warm-up ramp.
 * Must run unchanged in a browser: no Node/I/O/Date.now() (clock+RNG injected); depends only on @wp/utils.
 */
export const packageName = '@wp/domain' as const;

export type { Clock, Rng } from './ports.js';
export { TIMING } from './timing.js';

export {
  canTransition,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  type JobStatus,
} from './job/state-machine.js';

export {
  classify,
  RETRY_CLASS_BY_CATEGORY,
  TERMINAL_CATEGORIES,
  isTerminalCategory,
  type ProviderErrorLike,
  type RetryClass,
} from './retry/classify.js';

export {
  createDwrrSelector,
  DEFAULT_BAND_WEIGHTS,
  type Band,
  type DwrrSelector,
} from './queue/dwrr.js';

export { backoff, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './queue/backoff.js';

export {
  deliveryEventIdInput,
  providerEventIdInput,
  type ReceiptEventType,
} from './queue/delivery-event-id.js';

export {
  contentHashInput,
  normalizeWaJidForHash,
  type ContentHashFields,
  type ContentHashKind,
} from './queue/content-hash.js';

// Enum re-exports (./enums-exports.ts) and staff RBAC decision (P28 Unit U2, ./staff/index.ts) are sibling splits for the max-lines cap.
export * from './enums-exports.js';
export * from './staff/index.js';
export { BANNED_CLAIMS } from './copy/banned-claims.js';
export {
  SAFE_MODE_DISCLAIMER,
  BROADCAST_DISCLOSURE,
  BROADCAST_FREQUENCY_NOTE,
  BROADCAST_ESTIMATE_CAVEAT,
  GROUP_RISK_DISCLOSURE,
} from './copy/disclosures.js';
export { ONBOARDING_COPY, type OnboardingCopy } from './copy/onboarding.js';
export { PACING_COPY, type PacingCopy } from './copy/pacing-copy.js';
export { GUARD_COPY, type GuardCopyEntry } from './copy/guard-copy.js';
export { TOS_VERSION, TOS_VERSION_PATTERN } from './copy/tos-version.js';

export {
  realtimeChannel,
  parseRealtimeChannel,
  type RealtimeChannelParts,
} from './realtime/channel.js';

export { coalesceKeyFor, type CoalesceKeyInput } from './realtime/coalesce.js';
export { OUTBOX_EPHEMERAL_TOPICS, type OutboxEphemeralTopic } from './realtime/topics.js';

export {
  assertIdsOnly,
  REALTIME_PAYLOAD_KEYS,
  type RealtimePayloadEventType,
} from './realtime/assert-ids-only.js';

export {
  classifyAuthKeyType,
  DURABLE_KEY_TYPES,
  SIGNAL_KEY_TYPES,
  REBUILDABLE_KEY_TYPES,
  SIGNAL_KEY_TTL_MS,
  MAX_TRACKED_GROUP_PARTICIPANT_DEVICES,
  UnknownAuthKeyTypeError,
  type AuthKeyType,
  type AuthKeyTier,
  type DurableAuthKeyType,
  type SignalAuthKeyType,
  type RebuildableAuthKeyType,
} from './session/auth-key-types.js';

export { USER_ACTION_REASONS, type UserActionReason } from './instance/user-action-reasons.js';
export { PAIRING_MAX_ATTEMPTS } from './instance/pairing-constants.js';

export {
  beginPairing,
  pairingSucceeded,
  pairingExpired,
  applyDisconnect,
  type InstanceSnapshot,
  type Transition,
  type SideEffect,
  type DisconnectPolicyRowLike,
  type DisconnectBudgetCounters,
  type ApplyDisconnectContext,
} from './instance/session-fsm.js';

export {
  nextDelayMs,
  shouldGiveUp,
  onOpen,
  RECONNECT_GIVE_UP_REASON,
  BASE_DELAY_MS,
  CAP_DELAY_MS,
  MAX_ATTEMPTS,
  type NextDelayInput,
  type OnOpenInput,
} from './instance/reconnect-policy.js';

export { PARKED_COPY, PARKED_BUFFER_CAVEAT, maskPhoneE164 } from './copy/instance-copy.js';
export { INFRA_UNAVAILABLE_COPY } from './copy/infra-unavailable-copy.js';
export { COMPOSER_QUEUED_COPY, INSTANCE_OFFLINE_COPY } from './copy/send-copy.js';
export {
  UNRESOLVED_RETRY_BUTTON_COPY,
  UNRESOLVED_DISCARD_BUTTON_COPY,
  UNRESOLVED_EXPLANATION_COPY,
} from './copy/unresolved.js';

export {
  NOTIFICATION_COPY,
  type NotificationCopy,
  type NotificationCopyEntry,
  type NotificationEmailCopy,
} from './copy/notifications.js';

export { INSTANCE_CARD_COPY, type InstanceCardCopy } from './copy/instance-card.js';
export {
  NOTIFICATION_KIND_REGISTRY,
  type NotificationKindEntry,
  type NotificationChannel,
  type NotificationDedupeScope,
} from './notifications/kinds.js';

export {
  notificationDedupeKeyInput,
  type NotificationDedupeKeyInput,
} from './notifications/dedupe-key.js';
export { HEALTH_SIGNAL_NAMES, type HealthSignalName } from './pacing/health-signal-names.js';
export {
  fitRssRegression,
  TooFewRampPointsError,
  DegenerateRampPointsError,
  DegenerateResponseError,
  type RampPoint,
  type ConfidenceInterval,
  type RssRegressionFit,
} from './capacity/rss-regression.js';
export { fitLeastSquares, type XyPoint, type LeastSquaresFit } from './capacity/least-squares.js';
export {
  driftVerdict,
  type DriftSample,
  type DriftVerdictOptions,
  type DriftVerdict,
} from './capacity/drift-verdict.js';
export {
  loadModel,
  projectDailyGrowth,
  UnpublishableLoadModelError,
  InvalidLoadModelWindowError,
  InvalidLoadModelDeltaError,
  InvalidConnectedCountError,
  type LoadModelInput,
  type LoadModelSampleSize,
  type LoadModel,
  type DailyGrowthProjection,
} from './capacity/load-model.js';
export {
  groupStateMb,
  composeSessionMb,
  exceedsRedesignThreshold,
  InvalidRecordSizeError,
  InvalidTrackedDevicesError,
  type GroupStateInput,
  type ComposeSessionMbInput,
  type SessionMbProfile,
  type RedesignThresholdResult,
} from './capacity/session-cost-model.js';
export { trimmedMean } from './capacity/trimmed-mean.js';
export {
  ABSOLUTE_GAP_MIN_MS,
  ABSOLUTE_DAILY_CEILING,
  ABSOLUTE_GROUP_DAILY_CEILING,
  LONG_PAUSE_MIN_EVERY_N_SENDS,
  LONG_PAUSE_MAX_EVERY_N_SENDS,
  LONG_PAUSE_MULTIPLIER_MIN,
  LONG_PAUSE_MULTIPLIER_MAX,
  LONG_PAUSE_CAP_MS,
} from './pacing/constants.js';
export {
  clampAdminRelax,
  MAX_ADMIN_RELAX_MS,
  AdminRelaxExpiryError,
  AdminRelaxEmptyPatchError,
  AdminRelaxInvalidValueError,
  type AdminRelaxPatch,
} from './pacing/relax-bounds.js';

export {
  WARMUP_LADDER,
  HEALTH_BAND_EFFECTS,
  type WarmupTier,
  type HealthBand,
  type HealthBandEffect,
} from './pacing/warmup-ladder.js';

export {
  resolveEffective,
  type Layers,
  type PacingLayer,
  type AdminOverride,
  type EffectiveLimits,
  type LocalWindow,
} from './pacing/resolve-effective.js';

export {
  drawGapMs,
  applyLongPause,
  drawNextPauseThreshold,
  type LongPauseState,
  type LongPauseResult,
} from './pacing/gap-jitter.js';

export {
  DENY_REASONS,
  DENY_REASON_EFFECTS,
  type DenyReason,
  type DenyReasonEffect,
  type JobOutcome,
  type RetryAtRule,
} from './pacing/deny-reasons.js';

export {
  SEND_ORIGINS,
  EXEMPT_ORIGINS,
  NON_EXEMPT_ORIGINS,
  isExemptOrigin,
  type SendOrigin,
} from './pacing/send-origin.js';

export type { GuardDecision } from './pacing/guard-decision.js';
export { normaliseOptOutText } from './optout/normalise.js';
export { PLATFORM_OPTOUT_KEYWORDS, resolveOptOutKeywords } from './optout/keywords.js';
export { matchOptOutKeyword } from './optout/match.js';
export { normaliseForFingerprint } from './content/normalise-body.js';
export { LINK_RE, containsLink } from './content/link-regex.js';
export {
  matchBlockedWord,
  matchPreparedBlockedWord,
  prepareBlockedWordEntries,
  PLATFORM_BLOCKED_WORDS,
  type BlockedWordEntry,
  type PreparedBlockedWordEntry,
} from './content/blocked-word-match.js';

export {
  PRICE_KEYS,
  resolvePriceKey,
  type PriceKey,
  type ResolvePriceKeyInput,
} from './pricing.js';

export { nextWalletState, type NextWalletStateInput } from './wallet/state.js';
export {
  normaliseE164,
  waJidFromE164,
  type E164Reason,
  type E164Result,
  normalizeJidUser,
  normaliseJid,
  type AddressingMode,
  type JidResult,
  type NormaliseJidOptions,
} from './contacts/index.js';
export { CONTACTS_COPY, type ContactsCopy } from './copy/contacts.js';

export {
  shouldIgnoreJid,
  type InboundScope,
  type IgnoreJidOptions,
  extractOptOutCandidateText,
  OptOutCandidateText,
  OPTOUT_CANDIDATE_MAX_CHARS,
} from './inbound/index.js';

export * from './broadcast/index.js';
export * from './groups/index.js';
export * from './obs-exports.js';
export * from './media/media-exports.js';
