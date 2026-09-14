import type { createPool } from '@wp/db';

/**
 * entitlement.service.ts (P04b Unit UB1b, phase step 7) - the server-side
 * entitlement gate: `assertCanConnect`/`assertCanSend` decide whether a
 * caller may reach the Connect-WhatsApp flow or (eventually) send a message.
 * FAIL-CLOSED throughout (core invariant 2): a missing client/user row, an
 * unrecognized enum label, or any query error all DENY - never fall open.
 *
 * Every check runs in ONE GUC-scoped transaction: BEGIN READ ONLY ->
 * setAppClientId(clientId) -> reads -> COMMIT. `clientId` is taken from the
 * caller's own JWT claim (`req.auth.clientId`), never re-derived from
 * request input, so a caller can never probe another tenant's onboarding
 * state through this gate.
 *
 * Blueprint R-56 (canon): Connect WhatsApp is enabled only once the client is
 * `active`, the requesting user's email is verified, and `onboarding_step` is
 * at or past `connect_whatsapp` in the canonical 7-label order.
 */

// Mirrors packages/contracts/src/onboarding.ts's onboardingStepSchema order
// exactly (the DB enum's own label order) - kept as a plain local array
// rather than importing @wp/contracts here, since this file only needs the
// ORDER, not the zod schema, and modules/tenancy has no existing dependency
// on @wp/contracts to lean on.
const ONBOARDING_STEP_ORDER = [
  'verify_email',
  'choose_timezone',
  'accept_pacing_profile',
  'attest_consent',
  'connect_whatsapp',
  'send_test',
  'done',
] as const;

const CONNECT_WHATSAPP_INDEX = ONBOARDING_STEP_ORDER.indexOf('connect_whatsapp');

export class EmailNotVerifiedError extends Error {
  readonly code = 'EMAIL_NOT_VERIFIED';
  constructor() {
    super('Verify your email address before continuing.');
    this.name = 'EmailNotVerifiedError';
  }
}

export class EntitlementDeniedError extends Error {
  readonly code = 'FORBIDDEN';
  readonly details: Record<string, unknown>;
  constructor(reason: string) {
    super('This action is not available yet.');
    this.name = 'EntitlementDeniedError';
    this.details = { reason };
  }
}

export interface EntitlementDbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

export interface EntitlementDbPool {
  connect(): Promise<EntitlementDbClient>;
}

export interface EntitlementCtx {
  pool: EntitlementDbPool;
}

export interface EntitlementInput {
  clientId: string;
  userId: string;
}

interface ClientRow extends Record<string, unknown> {
  status: string;
  onboarding_step: string;
}

async function assertEntitled(ctx: EntitlementCtx, input: EntitlementInput): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('app.client_id', $1, true)`, [input.clientId]);

    // (a) requesting user's email must be verified. `users` carries no
    // client_id/RLS (identity is global - migration 0005), so this read is
    // never tenant-scoped by the GUC above; it is scoped by userId directly.
    const userResult = await client.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [input.userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow) {
      // Fail-closed: an unresolvable user is denied, never assumed verified.
      throw new EntitlementDeniedError('client_not_active');
    }
    if (!userRow.email_verified_at) {
      throw new EmailNotVerifiedError();
    }

    // (b)/(c) client must be active AND far enough along onboarding.
    const clientResult = await client.query<ClientRow>(
      `SELECT status, onboarding_step FROM clients WHERE id = $1
       -- client_id = id = $1
      `,
      [input.clientId],
    );
    const clientRow = clientResult.rows[0];
    if (!clientRow) {
      throw new EntitlementDeniedError('client_not_active');
    }
    if (clientRow.status !== 'active') {
      throw new EntitlementDeniedError('client_not_active');
    }

    const stepIndex = ONBOARDING_STEP_ORDER.indexOf(
      clientRow.onboarding_step as (typeof ONBOARDING_STEP_ORDER)[number],
    );
    if (stepIndex === -1) {
      // Unrecognized enum label - fail closed rather than guess an order.
      throw new EntitlementDeniedError('client_not_active');
    }
    if (stepIndex < CONNECT_WHATSAPP_INDEX) {
      throw new EntitlementDeniedError(`onboarding_incomplete:${clientRow.onboarding_step}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is what must propagate, not a rollback failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Gate for the Connect-WhatsApp flow (POST /v1/instances) - see the module doc comment. */
export async function assertCanConnect(
  ctx: EntitlementCtx,
  input: EntitlementInput,
): Promise<void> {
  await assertEntitled(ctx, input);
}

/**
 * Gate for sending. P04b uses the SAME predicate as `assertCanConnect`
 * (an instance cannot exist to send from before onboarding reaches
 * `connect_whatsapp` anyway); P08+ tightens this further once real instance/
 * wallet-balance checks exist.
 */
export async function assertCanSend(ctx: EntitlementCtx, input: EntitlementInput): Promise<void> {
  await assertEntitled(ctx, input);
}

export type EntitlementPool = ReturnType<typeof createPool>;
