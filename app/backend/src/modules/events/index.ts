/**
 * modules/events/index.ts (P15 U2, step 4; extended U4, step 5) - the
 * events module's public surface. `emit` is the ONLY sanctioned way a
 * business transaction writes an outbox row - see `emit.ts`'s own doc
 * comment for the full contract. `drainOnce`/`runOutboxCleanup` are the
 * relay's own two DB-driving ticks (`roles/relay.ts` composes them on
 * timers) - see `relay-loop.ts`/`cleanup.ts` for the full contract.
 */
export { emit, type EmitInput } from './emit.js';
export {
  drainOnce,
  DEFAULT_RELAY_CLAIM_LIMIT,
  DEFAULT_BACKPRESSURE_DEPTH_THRESHOLD,
  type BatchPublisherPort,
  type RelayMetricsPort,
  type RelayPool,
  type RelayPoolClient,
  type RelayLoopDeps,
  type WebhookFanoutPort,
  type ClaimedWebhookRow,
  type EmailFanoutPort,
  type ClaimedEmailRow,
} from './relay-loop.js';
export { runOutboxCleanup, type CleanupDeps } from './cleanup.js';
export { coalesceOutboxRows, type OutboxRow, type CoalescedGroup } from './coalescer.js';
