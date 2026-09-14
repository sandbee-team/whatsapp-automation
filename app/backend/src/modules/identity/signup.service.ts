import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantDb } from '@wp/db';
import { config } from '../../platform/config.js';
import * as identityRepoDefault from './identity.repo.js';
import { provisioningRepo as provisioningRepoDefault } from '../tenancy/index.js';
import { insertClientWithSlugRetry, SlugCollisionExhaustedError } from './signup-client-insert.js';

/**
 * signup.service.ts (P04a Unit A3) - the one-transaction signup use-case.
 * ONE `BEGIN`...`COMMIT` (via `@wp/db`'s `TenantDb.withTenant`, which also
 * sets `app.client_id` for the tenant-scoped tables' RLS policies) covers
 * every row: users -> clients -> memberships(owner) -> wallet_accounts ->
 * client_pricing -> wallet_ledger(signup_credit) -> wallet_ledger_ext_refs ->
 * audit_logs -> email_verification_tokens. Any error anywhere in that list
 * rolls back the whole thing - a partial signup is impossible. The
 * verification email is sent AFTER commit, and its own failure is logged,
 * never thrown (core invariant: a provider/port call never happens inside a
 * DB transaction, and never undoes committed work).
 */

// M17 (P04a FIXB): was a hard-coded literal - now sourced from platform/config.ts.
const DEFAULT_PRICE_LIST_KEY = config.DEFAULT_PRICE_LIST_KEY;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SLUG_SUFFIX_LENGTH = 6;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generic conflict error for every path that could otherwise leak a
 * cross-tenant existence oracle (reviewer finding N17): a duplicate email, a
 * slug collision surviving the one retry, and a second-workspace membership
 * attempt ALL surface as this same typed error with the same generic
 * message - never naming or implying which constraint fired or which other
 * workspace exists.
 */
export class SignupConflictError extends Error {
  readonly code = 'CONFLICT';

  constructor() {
    super('This account is already part of a workspace.');
    this.name = 'SignupConflictError';
  }
}

/**
 * Thrown when the default price list has no rows to derive `max_rate_minor`
 * from. `wallet_accounts.max_rate_minor` has no DB default and a `CHECK (> 0)`
 * (ADR 0019 S1) precisely so this can never be silently inserted as 0/NULL -
 * this error is what enforces that at the application layer, aborting the
 * whole transaction before any row is written.
 */
export class DefaultPriceListMissingError extends Error {
  readonly code = 'DEFAULT_PRICE_LIST_MISSING';

  constructor(priceListKey: string) {
    super(`Default price list "${priceListKey}" has no items; cannot provision a wallet.`);
    this.name = 'DefaultPriceListMissingError';
  }
}

/**
 * P28 U5 (item 3): thrown when no `plans` row has `is_default = true`.
 * `clients.plan_id` has no DB default, so this is what stops a zero-capacity
 * workspace (no plan -> no plan_limits row -> every entitlement check fails
 * closed to zero) from being silently created (core invariant 2). Aborts the
 * whole signup transaction before any row is written, same discipline as
 * `DefaultPriceListMissingError` above.
 */
export class NoDefaultPlanError extends Error {
  readonly code = 'INTERNAL';

  constructor() {
    super('No default plan is configured; cannot provision a workspace.');
    this.name = 'NoDefaultPlanError';
  }
}

export interface SignupInput {
  fullName: string;
  email: string;
  phoneE164?: string | null;
  companyName: string;
  /** Already-hashed (argon2id) - hashing itself is out of this unit's scope. */
  passwordHash?: string | null;
}

export interface SignupResult {
  userId: string;
  clientId: string;
}

type IdentityRepo = typeof identityRepoDefault;
type ProvisioningRepo = typeof provisioningRepoDefault;

export interface SignupCtx {
  tenantDb: TenantDb;
  /** Mailer port - called AFTER commit only; a failure here is logged, never thrown. */
  sendVerificationEmail: (to: string, verifyUrl: string) => Promise<void>;
  publicBaseUrl: string;
  signupCreditMinor: number;
  lowBalanceThresholdMinor: number;
  /** Defaults to `'default_inr'` - overridable by tests to probe the missing-price-list path. */
  priceListKey?: string;
  now?: () => Date;
  generateId?: () => string;
  generateVerificationToken?: () => Buffer;
  /**
   * FIX 5 (P04a FIXA C1 review): the random slug suffix generator -
   * overridable ONLY so a test can force a deterministic slug collision
   * (seed a fixed suffix, pre-insert a colliding `clients` row, then supply
   * a different suffix for the retry). Never used in production wiring.
   */
  generateSlugSuffix?: () => string;
  /** Test-double injection points - never used in production wiring. */
  identityRepo?: Partial<IdentityRepo>;
  provisioningRepo?: Partial<ProvisioningRepo>;
}

function slugify(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

function randomSlugSuffix(): string {
  const bytes = randomBytes(SLUG_SUFFIX_LENGTH);
  let out = '';
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i += 1) {
    out += SLUG_SUFFIX_ALPHABET[bytes[i]! % SLUG_SUFFIX_ALPHABET.length];
  }
  return out;
}

function buildSlug(companyName: string, generateSuffix: () => string): string {
  return `${slugify(companyName)}-${generateSuffix()}`;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

export async function signup(ctx: SignupCtx, input: SignupInput): Promise<SignupResult> {
  const identityRepo: IdentityRepo = { ...identityRepoDefault, ...ctx.identityRepo };
  const provisioningRepo: ProvisioningRepo = {
    ...provisioningRepoDefault,
    ...ctx.provisioningRepo,
  };
  const now = ctx.now ?? (() => new Date());
  const generateId = ctx.generateId ?? randomUUID;
  const generateVerificationToken = ctx.generateVerificationToken ?? (() => randomBytes(32));
  const generateSlugSuffix = ctx.generateSlugSuffix ?? randomSlugSuffix;
  const priceListKey = ctx.priceListKey ?? DEFAULT_PRICE_LIST_KEY;

  const userId = generateId();
  const clientId = generateId();
  const tokenId = generateId();
  const rawToken = generateVerificationToken();
  const tokenHash = createHash('sha256').update(rawToken).digest();
  const expiresAt = new Date(now().getTime() + VERIFICATION_TOKEN_TTL_MS);

  await ctx.tenantDb.withTenant(clientId, async (tx) => {
    try {
      await identityRepo.insertUser(tx, {
        id: userId,
        fullName: input.fullName,
        email: input.email,
        phoneE164: input.phoneE164 ?? null,
        passwordHash: input.passwordHash ?? null,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new SignupConflictError();
      }
      throw err;
    }

    // P28 U5 (item 3): resolved in this SAME transaction, right before the
    // `clients` INSERT that needs it - never a second, separately-committed
    // read (a plan default flipping between reads must never split-brain a
    // single signup's own client row).
    const planId = await provisioningRepo.readDefaultPlanId(tx);
    if (!planId) {
      throw new NoDefaultPlanError();
    }

    // FIX 5 (P04a FIXA C1 review) - see signup-client-insert.ts's own doc
    // comment for the SAVEPOINT-scoped one-retry dance this delegates to.
    try {
      await insertClientWithSlugRetry(tx, provisioningRepo, {
        clientId,
        companyName: input.companyName,
        ownerUserId: userId,
        planId,
        buildSlug: () => buildSlug(input.companyName, generateSlugSuffix),
      });
    } catch (err) {
      if (err instanceof SlugCollisionExhaustedError) {
        throw new SignupConflictError();
      }
      throw err;
    }

    try {
      await provisioningRepo.insertMembership(tx, { clientId, userId, role: 'owner' });
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_one_workspace_per_user_uq')) {
        throw new SignupConflictError();
      }
      throw err;
    }

    const maxRateMinor = await provisioningRepo.getMaxRateMinor(tx, priceListKey);
    if (maxRateMinor === null || maxRateMinor <= 0) {
      throw new DefaultPriceListMissingError(priceListKey);
    }

    await provisioningRepo.insertWalletAccount(tx, {
      clientId,
      currency: 'INR',
      balanceMinor: ctx.signupCreditMinor,
      lowBalanceThresholdMinor: ctx.lowBalanceThresholdMinor,
      maxRateMinor,
      entrySeq: 1,
      lifetimeCreditMinor: ctx.signupCreditMinor,
      lifetimeDebitMinor: 0,
    });

    await provisioningRepo.insertClientPricing(tx, {
      clientId,
      priceListKey,
      overrideItems: {},
    });

    const externalRef = `signup:${clientId}`;
    await provisioningRepo.insertWalletLedgerEntry(tx, {
      clientId,
      seq: 1,
      kind: 'signup_credit',
      amountMinor: ctx.signupCreditMinor,
      balanceAfterMinor: ctx.signupCreditMinor,
      quantity: 1,
      actorType: 'user',
      actorUserId: userId,
      externalRef,
    });

    await provisioningRepo.insertWalletLedgerExtRef(tx, {
      clientId,
      externalRef,
      seq: 1,
    });

    await provisioningRepo.insertAuditLog(tx, {
      clientId,
      actorType: 'user',
      actorUserId: userId,
      action: 'auth.signup',
      targetType: 'client',
      targetId: clientId,
      metadata: null,
    });

    await identityRepo.insertEmailVerificationToken(tx, {
      id: tokenId,
      userId,
      tokenHash,
      expiresAt,
    });
  });

  // AFTER COMMIT ONLY: a mail failure is logged, never thrown, and never
  // rolls anything back - the token is re-issuable later.
  const verifyUrl = `${ctx.publicBaseUrl}/verify-email?token=${rawToken.toString('hex')}`;
  try {
    await ctx.sendVerificationEmail(input.email, verifyUrl);
  } catch (err) {
    console.error('signup: failed to send verification email (non-fatal):', {
      name: err instanceof Error ? err.name : 'Error',
      code: (err as { code?: unknown } | null)?.code,
    });
  }

  return { userId, clientId };
}
