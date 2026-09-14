import { createHash } from 'node:crypto';
import type { TenantDb } from '@wp/db';
import { API_TIME_REJECTION_REASONS, groupRecipientHashInput, isGroupJid } from '@wp/domain';
import type { JobPriority, SendOrigin } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { GroupSendRejectedError, resolveGroupForEnqueue } from '../groups/index.js';
import { readLinkStatus, type InstanceCtx } from '../instances/index.js';
import { isOptedOut } from '../pacing/index.js';
import { advanceToDoneIfSendTest } from '../tenancy/index.js';
import { payloadKindFor, resolveMediaIdForEnqueue } from './messages.media-resolve.js';
import {
  countQueuedJobsForInstance,
  enqueueMessageJob,
  findExistingJobRef,
} from './messages.repo.js';
import { replayResultFor } from './messages.service-idempotency.js';

/**
 * messages.service.ts (P11 Unit U3) - the send-path MVP's enqueue service:
 * authz/entitlement is the ROUTE's job (`requireCanSend`, unchanged); THIS
 * file owns instance-state gating (fail-safe pause preserves work - core
 * invariant 5: an offline instance still QUEUES the job) and the
 * per-instance queue-depth cap, then delegates the durable write itself to
 * `messages.repo.ts`'s one transaction.
 *
 * QUEUE-DEPTH CAP GAP: `MAX_QUEUED_JOBS_PER_INSTANCE` below is a deliberate
 * module constant, not a `plan_limits` column (no ADR yet). No override.
 */
export const MAX_QUEUED_JOBS_PER_INSTANCE = 10_000;

export class InstanceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such WhatsApp instance.');
    this.name = 'InstanceNotFoundError';
  }
}

/**
 * `link_state = 'unlinked'` - the instance was never paired at all. Fails
 * CLOSED at the API (never in the worker): no durable job is created.
 */
export class InstanceUnlinkedError extends Error {
  readonly code = 'INSTANCE_UNLINKED';
  constructor() {
    super('This WhatsApp instance has not been linked yet.');
    this.name = 'InstanceUnlinkedError';
  }
}

export class QueueDepthCapExceededError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('This instance has reached its maximum number of queued messages.');
    this.name = 'QueueDepthCapExceededError';
  }
}

/**
 * The enqueue-time opt-out gate (P14 Unit U4, step 5): the recipient has an
 * unrestored `opt_outs` row at client or instance scope. Fails CLOSED,
 * BEFORE any durable write - no `message_jobs` row, no `message_job_refs`
 * row, no wallet mutation (core invariant 3, idempotency at the storage
 * layer - nothing is created that a later retry would need to reconcile).
 * Group (`@g.us`) recipients never reach this error - `createMessage` skips
 * the opt-out check entirely for a group recipient (see its own call site).
 */
export class RecipientOptedOutError extends Error {
  readonly code = 'RECIPIENT_OPTED_OUT';
  constructor() {
    super('This recipient has opted out of messages.');
    this.name = 'RecipientOptedOutError';
  }
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  constructor() {
    super('This Idempotency-Key was already used with a different request body.');
    this.name = 'IdempotencyKeyReusedError';
  }
}

/** SHA-256 of the canonical JSON request body - the fingerprint `message_job_refs.request_hash` stores and every idempotency-key conflict is compared against. */
export function computeRequestHash(body: Record<string, unknown>): Buffer {
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest();
}

export interface CreateMessageServiceInput {
  clientId: string;
  instanceId: string;
  idempotencyKey: string;
  requestBody: Record<string, unknown>;
  recipient: { jid: string; e164: string | null };
  payload: Record<string, unknown>;
  /** The CONTRACT kind (`'text'|'image'|'document'`) - mapped to the coarse DB `payload_kind` via `payloadKindFor` (ADR 0052 S7.1). */
  payloadKind: string;
  priority: JobPriority;
  scheduledAt: Date | null;
  actorUserId?: string | null;
  /**
   * The typed send origin (never `origin` - see `scripts/check-send-origin.ts`
   * clause (b)). Threaded from the caller, NEVER read from the request body -
   * the route binds this to the literal `'api_send'`; this field exists so a
   * later internal caller (system-send) can thread a different origin
   * through the SAME service without a second enqueue code path.
   */
  sendOrigin: SendOrigin;
}

export interface CreateMessageServiceResult {
  id: string;
  status: 'queued';
  /** Present only when the instance is `linked` but not `connected` - the blueprint's `202 warning: INSTANCE_OFFLINE` (never an error code: the job WAS created and queued). */
  warning?: 'INSTANCE_OFFLINE';
}

export interface EnqueuedWakeEvent {
  clientId: string;
  instanceId: string;
}

export interface CreateMessageServiceDeps {
  /**
   * The wake port (`engine/queue/wake.ts#publishWake`, bound by the
   * caller) - invoked EXACTLY ONCE, AFTER `tenantDb.withTenant`'s own
   * promise has already resolved (i.e. after the enqueue transaction has
   * committed), never from inside the transaction callback. A wake
   * published before commit risks a subscriber waking to a row it cannot
   * yet see under its own read (`wake.ts`'s own module doc). Optional and
   * defaulting to a no-op so the one existing production call site
   * (`messages.routes.ts`, outside this unit's file scope) keeps compiling
   * unchanged until it is wired.
   */
  onEnqueued?: (event: EnqueuedWakeEvent) => void | Promise<void>;
  /**
   * The `optout-pepper` KEK provider (`hashRecipient`'s own contract) -
   * REQUIRED (no default): every call must be able to compute the opt-out
   * lookup hash. A production caller mounts `'optout-pepper'` alongside
   * `'session'` (see `roles/api.ts`'s wiring); a test caller passes a
   * `FileKeyProvider` over the fixture ring.
   */
  keyProvider: KeyProvider;
}

const NOOP_ON_ENQUEUED: NonNullable<CreateMessageServiceDeps['onEnqueued']> = () => undefined;

/**
 * The full enqueue service call: instance ownership -> link-state gate ->
 * queue-depth cap -> the one enqueue transaction. `tenantDb` opens exactly
 * ONE `withTenant` transaction for the whole call - the cap check and the
 * write it guards must see a consistent snapshot, and the write itself must
 * never run outside a client-scoped transaction (tenant isolation, core
 * invariant 4). `deps.onEnqueued` (step 8's wake publish) fires strictly
 * AFTER that transaction has committed - see `CreateMessageServiceDeps`'s
 * own doc comment.
 */
export async function createMessage(
  tenantDb: TenantDb,
  input: CreateMessageServiceInput,
  deps: CreateMessageServiceDeps,
): Promise<CreateMessageServiceResult> {
  const onEnqueued = deps.onEnqueued ?? NOOP_ON_ENQUEUED;

  const result = await tenantDb.withTenant(input.clientId, async (tx) => {
    const ctx: InstanceCtx = { clientId: input.clientId, sql: tx };
    const status = await readLinkStatus(ctx, input.instanceId);
    if (!status) {
      throw new InstanceNotFoundError();
    }
    if (status.linkState === 'unlinked') {
      throw new InstanceUnlinkedError();
    }

    const queuedCount = await countQueuedJobsForInstance(tx, input.clientId, input.instanceId);
    if (queuedCount >= MAX_QUEUED_JOBS_PER_INSTANCE) {
      throw new QueueDepthCapExceededError();
    }

    // 'connected' is the only health_state under which sends may actually
    // proceed; every other label (never_linked, degraded, paused,
    // logged_out) is the blueprint's INSTANCE_OFFLINE warning - the job is
    // still durably queued (pause preserves work, core invariant 5), never
    // rejected. Computed here (not only at the bottom) so the replay
    // pre-check below can return the same shape a fresh enqueue would.
    const warning = status.healthState === 'connected' ? undefined : ('INSTANCE_OFFLINE' as const);

    // Idempotency-replay pre-check (P24 C2 fix round, Fix 2; api.md rule 2):
    // resolved BEFORE the group/opt-out eligibility lookup below, so a
    // replay of an already-enqueued key returns the ORIGINAL job even if
    // the recipient (a group, in particular) has since become ineligible -
    // it never re-runs (and never fails) that lookup for a known replay.
    const requestHashForReplayCheck = computeRequestHash(input.requestBody);
    const existingRef = await findExistingJobRef(tx, {
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
    });
    const replayResult = replayResultFor(existingRef, requestHashForReplayCheck, warning);
    if (replayResult) {
      return replayResult;
    }

    // Media resolve (ADR 0052 item 5): no-op for 'text'; 404s before any job row for a missing/foreign mediaId.
    await resolveMediaIdForEnqueue(tx, input.clientId, input.payloadKind, input.payload);

    // Enqueue-time opt-out gate (step 5): group (`@g.us`) recipients skip
    // the check entirely - a group is never opted out (registry.ts's own
    // "excluded by recipient_jid shape" contract). Instead (P24 U4a, step
    // 6) a group recipient runs the group-send-eligibility lookup BEFORE
    // any durable write: `NOT_SEND_ENABLED`/`ANNOUNCE_MEMBER_ONLY` (the API-
    // time rejection reasons - `@wp/domain`'s `API_TIME_REJECTION_REASONS`)
    // throw here, no job row, no ref row (core invariant 1's "reject before
    // creating jobs" half). `GROUP_CAP_ZERO_AT_TIER` is deliberately NOT a
    // member of that set - the job below is still created and defers with
    // `GROUP_DAILY_CAP` at reserve() time, the same durable-job-row-first
    // discipline every other send path follows.
    const isGroup = isGroupJid(input.recipient.jid);
    const canonicalRecipient = isGroup
      ? groupRecipientHashInput(input.recipient.jid)
      : input.recipient.jid;
    const recipientHash = hashRecipient(
      deps.keyProvider,
      isGroup ? canonicalRecipient : (input.recipient.e164 ?? input.recipient.jid),
    );
    if (isGroup) {
      const lookup = await resolveGroupForEnqueue(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        canonicalGroupJid: canonicalRecipient,
      });
      if (!lookup.sendable && lookup.reason && API_TIME_REJECTION_REASONS.has(lookup.reason)) {
        throw new GroupSendRejectedError(lookup.reason);
      }
    } else {
      const optedOut = await isOptedOut(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        phoneHash: recipientHash,
      });
      if (optedOut) {
        throw new RecipientOptedOutError();
      }
    }

    // Same value `findExistingJobRef` already compared above - recomputed
    // is unnecessary, kept as one binding so the CONCURRENT-race branch
    // below (a second request whose OWN `findExistingJobRef` read also saw
    // nothing, because neither transaction had committed yet) still has a
    // hash to compare against `enqueueMessageJob`'s own conflict-branch
    // result.
    const requestHash = requestHashForReplayCheck;
    const enqueued = await enqueueMessageJob(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      recipient: isGroup ? { jid: canonicalRecipient, e164: null } : input.recipient,
      recipientHash,
      sendOrigin: input.sendOrigin,
      payload: input.payload,
      payloadKind: payloadKindFor(input.payloadKind), // ADR 0052 S7.1: job_kind stays two-valued
      priority: input.priority,
      scheduledAt: input.scheduledAt,
      actorUserId: input.actorUserId,
    });

    if (!enqueued.created) {
      // The CONCURRENT-race branch: `enqueueMessageJob`'s own `ON CONFLICT`
      // fired even though this transaction's OWN `findExistingJobRef` read
      // (above) saw nothing yet - a second request racing the first,
      // neither having committed at read time. Compare request_hash before
      // returning the original response - equal means a genuine retry
      // (replay it), different means key reuse with a different body (fail
      // closed, never silently serve someone else's job as if it matched).
      const original = enqueued.requestHash;
      if (!original || !original.equals(requestHash)) {
        throw new IdempotencyKeyReusedError();
      }
    } else {
      // P28 U5 (item 2): only on a genuinely NEW enqueue (never a replay) -
      // `enqueued.created` is `false` for both the pre-check replay (which
      // already returned above) and this concurrent-race replay branch, so
      // this only ever fires once per idempotency key. Own conditional
      // statement, same transaction as the job+ref insert above.
      await advanceToDoneIfSendTest(tx, input.clientId);
    }

    return { id: enqueued.publicId, status: 'queued' as const, ...(warning ? { warning } : {}) };
  });

  // step 8: publish the wake AFTER the transaction above has already
  // committed (`await` on `withTenant`'s own promise already guarantees
  // that ordering) - never inside the callback. Fires on every completed
  // call, including an idempotent replay (a duplicate wake is only ever a
  // hint downstream - see `engine/queue/wake.ts`'s own module doc).
  await onEnqueued({ clientId: input.clientId, instanceId: input.instanceId });

  return result;
}
