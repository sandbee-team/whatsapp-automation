import type { TenantDb } from '@wp/db';
import type { Actor } from '../pacing/health/transitions.js';
import { humanResume } from '../pacing/index.js';
import { provisioningRepo } from '../tenancy/index.js';
import { emit } from '../events/index.js';
import {
  AcknowledgementRequiredError,
  InstanceNotFoundError,
  InvalidStateError,
  redactLongDigitRuns,
  ResumeRequiresUserError,
} from './resume-support.js';

/**
 * resume.ts (P16 Unit D, step 8) - `resumeInstance`, the ONLY caller of
 * `modules/pacing/health/human-resume.ts#humanResume` (that module's own doc
 * comment: it is the ONE function that can take `health_state` out of
 * `'paused'`, and NEVER writes audit/outbox/wake itself - this is the HTTP-
 * layer counterpart that adds exactly those three writes, all inside the
 * SAME `withTenant` transaction as the state write, then publishes a wake
 * strictly after commit).
 *
 * ACTOR GUARD (defence in depth, core invariant 2 fail-safe + safety-
 * compliance "no automatic resume, ever"): `input.actor` is typed as
 * `transitions.ts`'s own `Actor` union (not narrowed to `UserActor` at the
 * call site) so this function's OWN runtime check is what a future API-key
 * caller (today's route surface only ever authenticates a human session -
 * see this unit's dispatch note) will hit - `actor.type !== 'user'` throws
 * `ResumeRequiresUserError` (403 RESUME_REQUIRES_USER) BEFORE any read or
 * write, for EVERY pause cause, not just provider_restriction.
 *
 * ACKNOWLEDGEMENT GUARD: when the current `pause_reason` is
 * `'provider_restriction'`, `input.acknowledgement` must be exactly `true`
 * (never a truthy string/number - the caller already parsed the body through
 * `resumeInstanceInputSchema`'s `z.boolean()`) or this throws
 * `AcknowledgementRequiredError` (422) before any write.
 *
 * ONE TRANSACTION: read (ownership + current `pause_reason`) -> guards ->
 * `humanResume` (the one conditional UPDATE) -> `audit_logs` row ->
 * `instance.resumed` outbox row, all on the same `tx`. The wake publish runs
 * AFTER the transaction resolves (same "never inside the business
 * transaction" discipline `ack-fanout.ts`'s own header comment documents) -
 * this is the normative rule verbatim: every transition that turns a
 * zero-claim state into a claimable one publishes a wake in the same code
 * path as the commit, never a detached fire-and-forget elsewhere.
 */

export interface ResumeInstanceDeps {
  tenantDb: TenantDb;
  /** `engine/queue/wake.ts#publishWake`, bound by the caller - invoked strictly after the transaction below has committed. */
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
}

export interface ResumeInstanceInput {
  clientId: string;
  instanceId: string;
  actor: Actor;
  reason?: string;
  acknowledgement?: boolean;
}

export interface ResumeInstanceResult {
  healthState: 'degraded';
}

interface CurrentRow extends Record<string, unknown> {
  health_state: string;
  pause_reason: string | null;
}

async function readCurrentOrThrow(
  tx: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  },
  clientId: string,
  instanceId: string,
): Promise<CurrentRow> {
  const result = await tx.query<CurrentRow>(
    `SELECT health_state, pause_reason FROM whatsapp_instances
      WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new InstanceNotFoundError();
  return row;
}

/** Resumes a paused instance for a human actor - see module doc for the full guard/transaction/wake contract. */
export async function resumeInstance(
  deps: ResumeInstanceDeps,
  input: ResumeInstanceInput,
): Promise<ResumeInstanceResult> {
  if (input.actor.type !== 'user') {
    throw new ResumeRequiresUserError();
  }
  const actor = input.actor;

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const current = await readCurrentOrThrow(tx, input.clientId, input.instanceId);

    if (current.health_state !== 'paused') {
      throw new InvalidStateError('This instance is not currently paused.');
    }

    if (current.pause_reason === 'provider_restriction' && input.acknowledgement !== true) {
      throw new AcknowledgementRequiredError();
    }

    await humanResume(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      actor,
    });

    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'instance.resume',
      targetType: 'instance',
      targetId: input.instanceId,
      metadata: {
        // WARNING 7 fix (P16 fix round): a free-text reason can carry a
        // phone-shaped digit run - redact before it ever reaches audit
        // metadata, mirroring the evidence path's own no-PII discipline.
        reason: redactLongDigitRuns(input.reason),
        acknowledgement: input.acknowledgement ?? false,
      },
    });

    await emit(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      type: 'instance.resumed',
      entityId: input.instanceId,
      payload: { instanceId: input.instanceId, healthState: 'degraded' },
      fanout: ['sse', 'webhook'],
    });
  });

  await deps.publishWake(input.clientId, input.instanceId);

  return { healthState: 'degraded' };
}
