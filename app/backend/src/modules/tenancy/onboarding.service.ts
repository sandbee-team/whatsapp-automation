import { TOS_VERSION } from '@wp/domain';
import * as onboardingRepoDefault from './onboarding.repo.js';

/**
 * onboarding.service.ts (P04b Unit UB1b, phase step 8) - the onboarding step
 * machine's orchestration. Each advance opens ONE transaction:
 * BEGIN -> setAppClientId(clientId) -> conditional UPDATE (+ audit insert for
 * consent) -> COMMIT. Monotonic, ordered advancement only (Blueprint R-56):
 * every write is a single conditional `UPDATE ... WHERE onboarding_step =
 * expected` (core invariant 3 - idempotency/ordering enforced at the storage
 * layer, never an in-memory check). A zero-row update means the client is NOT
 * on the expected step - re-read the CURRENT step in the same transaction and
 * throw `OnboardingOutOfOrderError` naming it, never silently skip or move
 * backwards.
 */

export class OnboardingOutOfOrderError extends Error {
  readonly code = 'CONFLICT';
  readonly details: Record<string, unknown>;
  constructor(currentStep: string) {
    super('This onboarding step is not available yet.');
    this.name = 'OnboardingOutOfOrderError';
    this.details = { currentStep };
  }
}

export class ClientNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such client.');
    this.name = 'ClientNotFoundError';
  }
}

export interface OnboardingDbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

export interface OnboardingDbPool {
  connect(): Promise<OnboardingDbClient>;
}

type OnboardingRepo = typeof onboardingRepoDefault;

export interface OnboardingCtx {
  pool: OnboardingDbPool;
  now?: () => Date;
  /** Test-double injection point - never used in production wiring. */
  onboardingRepo?: Partial<OnboardingRepo>;
}

export interface OnboardingStatus {
  step: string;
  timezone: string | null;
  pacingProfileKey: string | null;
  consentAttestedAt: string | null;
  consentTosVersion: string | null;
}

async function withTenantTransaction<T>(
  ctx: OnboardingCtx,
  clientId: string,
  fn: (client: OnboardingDbClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.client_id', $1, true)`, [clientId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
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

export async function getOnboardingStatus(
  ctx: OnboardingCtx,
  clientId: string,
): Promise<OnboardingStatus> {
  const repo: OnboardingRepo = { ...onboardingRepoDefault, ...ctx.onboardingRepo };
  return withTenantTransaction(ctx, clientId, async (client) => {
    const row = await repo.getOnboardingStatus(client, clientId);
    if (!row) throw new ClientNotFoundError();
    return {
      step: row.onboarding_step,
      timezone: row.timezone,
      pacingProfileKey: row.pacing_profile_key,
      consentAttestedAt: row.consent_attested_at ? row.consent_attested_at.toISOString() : null,
      consentTosVersion: row.consent_tos_version,
    };
  });
}

async function currentStepOrThrowNotFound(
  repo: OnboardingRepo,
  client: OnboardingDbClient,
  clientId: string,
): Promise<string> {
  const currentStep = await repo.getOnboardingStep(client, clientId);
  if (currentStep === null) throw new ClientNotFoundError();
  return currentStep;
}

export interface SetTimezoneInput {
  clientId: string;
  timezone: string;
}

/** IANA-shape validation happens at the contract boundary (routes) - this trusts `timezone` is already validated. */
export async function setTimezone(
  ctx: OnboardingCtx,
  input: SetTimezoneInput,
): Promise<{ step: string }> {
  const repo: OnboardingRepo = { ...onboardingRepoDefault, ...ctx.onboardingRepo };
  return withTenantTransaction(ctx, input.clientId, async (client) => {
    const advanced = await repo.setTimezoneAndAdvance(client, input.clientId, input.timezone);
    if (!advanced) {
      const currentStep = await currentStepOrThrowNotFound(repo, client, input.clientId);
      throw new OnboardingOutOfOrderError(currentStep);
    }
    return { step: 'accept_pacing_profile' };
  });
}

export interface SetPacingProfileInput {
  clientId: string;
  profileKey: string;
}

export async function setPacingProfile(
  ctx: OnboardingCtx,
  input: SetPacingProfileInput,
): Promise<{ step: string }> {
  const repo: OnboardingRepo = { ...onboardingRepoDefault, ...ctx.onboardingRepo };
  const now = ctx.now ?? (() => new Date());
  return withTenantTransaction(ctx, input.clientId, async (client) => {
    const advanced = await repo.setPacingProfileAndAdvance(
      client,
      input.clientId,
      input.profileKey,
      now(),
    );
    if (!advanced) {
      const currentStep = await currentStepOrThrowNotFound(repo, client, input.clientId);
      throw new OnboardingOutOfOrderError(currentStep);
    }
    return { step: 'attest_consent' };
  });
}

export interface SetConsentInput {
  clientId: string;
  userId: string;
}

/**
 * The contract input stays `{ accepted: true }` (packages/contracts) - the
 * SERVER is authoritative for which ToS version was accepted, never the
 * client, so `TOS_VERSION` is read here rather than taken from `input`.
 */
export async function setConsent(
  ctx: OnboardingCtx,
  input: SetConsentInput,
): Promise<{ step: string }> {
  const repo: OnboardingRepo = { ...onboardingRepoDefault, ...ctx.onboardingRepo };
  const now = ctx.now ?? (() => new Date());
  return withTenantTransaction(ctx, input.clientId, async (client) => {
    const advanced = await repo.setConsentAndAdvance(
      client,
      input.clientId,
      input.userId,
      now(),
      TOS_VERSION,
    );
    if (!advanced) {
      const currentStep = await currentStepOrThrowNotFound(repo, client, input.clientId);
      throw new OnboardingOutOfOrderError(currentStep);
    }
    await repo.insertConsentAuditLog(client, input.clientId, input.userId, TOS_VERSION);
    return { step: 'connect_whatsapp' };
  });
}
