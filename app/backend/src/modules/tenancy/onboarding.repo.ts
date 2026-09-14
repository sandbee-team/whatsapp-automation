import type { TenantQueryable } from '@wp/db';
import { insertAuditLog } from './provisioning.repo.js';

/**
 * onboarding.repo.ts (P04b Unit UB1b, phase step 8) - SQL ONLY, no business
 * `if`s (same discipline as provisioning.repo.ts's header comment).
 * Orchestration (which step is "current", monotonic-order enforcement,
 * conflict-error mapping) lives in onboarding.service.ts.
 */

export interface OnboardingStatusRow extends Record<string, unknown> {
  onboarding_step: string;
  timezone: string;
  pacing_profile_key: string | null;
  consent_attested_at: Date | null;
  consent_tos_version: string | null;
}

/** Reads the current onboarding status row for `clientId`. Returns `null` if the client does not exist. */
export async function getOnboardingStatus(
  sql: TenantQueryable,
  clientId: string,
): Promise<OnboardingStatusRow | null> {
  const result = await sql.query<OnboardingStatusRow>(
    `SELECT onboarding_step, timezone, pacing_profile_key, consent_attested_at, consent_tos_version
       FROM clients WHERE id = $1
     -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows[0] ?? null;
}

/** Reads only the current `onboarding_step` for `clientId` - used to name the current step in a conflict error. */
export async function getOnboardingStep(
  sql: TenantQueryable,
  clientId: string,
): Promise<string | null> {
  const result = await sql.query<{ onboarding_step: string }>(
    `SELECT onboarding_step FROM clients WHERE id = $1
     -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows[0]?.onboarding_step ?? null;
}

/**
 * Sets `timezone` and advances `choose_timezone` -> `accept_pacing_profile` -
 * conditional on the CURRENT step still being `choose_timezone` (monotonic-
 * safe, core invariant 3: idempotency/ordering enforced at the storage layer
 * via the WHERE clause, never an in-memory check). Returns whether a row was
 * actually updated.
 */
export async function setTimezoneAndAdvance(
  sql: TenantQueryable,
  clientId: string,
  timezone: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET timezone = $2,
            onboarding_step = 'accept_pacing_profile'
      WHERE id = $1
        AND onboarding_step = 'choose_timezone'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId, timezone],
  );
  return result.rows.length > 0;
}

/**
 * Sets `pacing_profile_key` (+ `pacing_profile_accepted_at`) and advances
 * `accept_pacing_profile` -> `attest_consent` - conditional on the current
 * step. `pacing_profiles` does not exist until P13 (per phase canon): the key
 * is recorded as free text, deliberately NOT foreign-keyed.
 */
export async function setPacingProfileAndAdvance(
  sql: TenantQueryable,
  clientId: string,
  profileKey: string,
  acceptedAt: Date,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET pacing_profile_key = $2,
            pacing_profile_accepted_at = $3,
            onboarding_step = 'attest_consent'
      WHERE id = $1
        AND onboarding_step = 'accept_pacing_profile'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId, profileKey, acceptedAt],
  );
  return result.rows.length > 0;
}

/**
 * Sets the two consent-attestation columns plus `consent_tos_version` and
 * advances `attest_consent` -> `connect_whatsapp` - conditional on the
 * current step. `tosVersion` is server-supplied (`@wp/domain#TOS_VERSION`,
 * see onboarding.service.ts) - never client input. The audit_logs row
 * naming the attesting user is inserted separately, in the SAME transaction,
 * by the caller (onboarding.service.ts) via `insertConsentAuditLog` below.
 */
export async function setConsentAndAdvance(
  sql: TenantQueryable,
  clientId: string,
  attestedByUserId: string,
  attestedAt: Date,
  tosVersion: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET consent_attested_at = $2,
            consent_attested_by_user_id = $3,
            consent_tos_version = $4,
            onboarding_step = 'connect_whatsapp'
      WHERE id = $1
        AND onboarding_step = 'attest_consent'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId, attestedAt, attestedByUserId, tosVersion],
  );
  return result.rows.length > 0;
}

/**
 * Inserts the consent-attestation audit_logs row - reuses
 * provisioning.repo.ts's `insertAuditLog` (ALLOWED_AUDIT_METADATA_KEYS
 * filter) rather than duplicating the INSERT, per the phase task's binding
 * instruction to find and reuse it. `metadata.tos_version` (P29a step 10)
 * records the same server-supplied version stamped on the client row above.
 */
export async function insertConsentAuditLog(
  sql: TenantQueryable,
  clientId: string,
  attestedByUserId: string,
  tosVersion: string,
): Promise<void> {
  await insertAuditLog(sql, {
    clientId,
    actorType: 'user',
    actorUserId: attestedByUserId,
    action: 'onboarding.consent_attested',
    targetType: 'client',
    targetId: clientId,
    metadata: { tos_version: tosVersion },
  });
}

/**
 * P28 U5 (item 2): `connect_whatsapp` -> `send_test` - conditional on the
 * CURRENT step (same monotonic-safe shape as `setTimezoneAndAdvance` above),
 * fired right after the engine's own link-transition write
 * (`instance-mark-linked-connected.sql`'s TS caller,
 * `modules/instances/repo.ts#markLinkedConnected`) succeeds. Never throws on
 * zero rows (a client already past `connect_whatsapp`, or a client that
 * links a SECOND number after the first already advanced it, are both
 * benign no-ops on this hot path - the caller does not branch on the
 * result).
 */
export async function advanceToSendTestIfConnecting(
  sql: TenantQueryable,
  clientId: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET onboarding_step = 'send_test', updated_at = now()
      WHERE id = $1 AND onboarding_step = 'connect_whatsapp'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows.length > 0;
}

/**
 * P28 U5 (item 2): `send_test` -> `done` - same conditional/monotonic shape
 * as `advanceToSendTestIfConnecting` above, fired after `createMessage`'s
 * job + ref insert (messages.service.ts) commits. A zero-row result (not yet
 * at `send_test`, or already `done`) is a benign no-op, never thrown - the
 * per-message hot path never branches on it.
 */
export async function advanceToDoneIfSendTest(
  sql: TenantQueryable,
  clientId: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET onboarding_step = 'done', updated_at = now()
      WHERE id = $1 AND onboarding_step = 'send_test'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows.length > 0;
}
