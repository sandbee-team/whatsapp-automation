import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { internalMutationHeadersSchema } from '@wp/contracts';
import { verifyServiceToken, isIpAllowed } from './service-token.js';
import { sendError } from '../../platform/http/error-mapper.js';
import type { AdminAppQueryable } from './staff-audit.js';

/**
 * internal-access.ts (P19 Unit U5, step 8; P28 Unit U3a, step 4 rewrite) -
 * the shared gate/repo-read primitives every `/internal/v1` route uses.
 * `requireStaffContext`/`StaffContext` (the P19 `X-WP-Staff-Id`/
 * `X-WP-Staff-Reason` headers) are REMOVED - reason now travels in the body,
 * the acting staff member travels in `X-Actor` (`@wp/contracts`'s
 * `internalMutationHeadersSchema`, resolved via `actor.ts#resolveStaffActor`
 * inside `with-staff-mutation.ts`).
 */

/**
 * `internalMutationHeadersSchema` with `x-actor` relaxed to PRESENCE only -
 * derived from the contract schema (never a hand-copied duplicate) so the
 * `idempotency-key` bounds stay in one place. See `parseMutationHeaders` for
 * why the actor's SHAPE is checked later, by `resolveStaffActor`, as a 403.
 */
const mutationHeaderPresenceSchema = internalMutationHeadersSchema.extend({
  'x-actor': z.string().trim().min(1),
});

export interface InternalAccessDeps {
  serviceTokenSecret: string;
  allowedCidrs: string;
  now?: () => Date;
}

export class InternalUnauthorizedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Missing or invalid internal service token.');
    this.name = 'InternalUnauthorizedError';
  }
}

export class InternalValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'InternalValidationError';
  }
}

export class TopupNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('Top-up request not found.');
    this.name = 'TopupNotFoundError';
  }
}

export class TopupNotPendingError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('This top-up request has already been reviewed.');
    this.name = 'TopupNotPendingError';
  }
}

/**
 * Gate (2)+(3): IP allow-list then service token - throws
 * `InternalUnauthorizedError` on any failure, never distinguishing WHICH
 * check failed (no information leak to an unauthenticated caller).
 *
 * The signed path is taken from the REQUEST (`req.url`, query string
 * stripped), never from the route's registered template. This is a security
 * boundary, not a convenience: a token signed over
 * `/internal/v1/clients/:id/wallet/credit` would be valid for EVERY client's
 * wallet, so one captured header would credit any tenant. Binding the
 * concrete `/internal/v1/clients/<uuid>/wallet/credit` means a token is
 * worthless against any other client, route, or method - which is exactly
 * what `internal-auth.integration.test.ts#
 * an_internal_mutation_without_a_valid_service_token_writes_nothing`'s
 * "replayed-for-another-path" case pins. Deliberately takes NO `path`
 * parameter, so a future route cannot reintroduce a template-wide token by
 * passing one.
 */
export function assertInternalAccess(req: FastifyRequest, deps: InternalAccessDeps): void {
  if (!isIpAllowed(req.ip, deps.allowedCidrs)) {
    throw new InternalUnauthorizedError();
  }
  const header = req.headers['x-wp-internal-token'];
  const now = deps.now ? deps.now() : new Date();
  const ok = verifyServiceToken({
    secret: deps.serviceTokenSecret,
    method: req.method,
    path: req.url.split('?')[0] ?? req.url,
    header: typeof header === 'string' ? header : undefined,
    now,
  });
  if (!ok) {
    throw new InternalUnauthorizedError();
  }
}

/**
 * Asserts the two mandatory mutation headers are PRESENT, and returns them.
 *
 * The 400-vs-403 split here is deliberate and load-bearing:
 *  - a MISSING (or blank) `idempotency-key`/`x-actor` is a malformed request
 *    -> `ZodError` -> 400 `VALIDATION_ERROR`, raised BEFORE `withStaffMutation`
 *    is entered, so zero rows are written;
 *  - a PRESENT but non-staff actor (`system`, `api_key:...`, a bare uuid) is
 *    an AUTHORIZATION failure, not a validation one - `/internal/v1`
 *    mutations are always a named staff member acting. That verdict belongs
 *    to `actor.ts#resolveStaffActor`, which returns the same undistinguished
 *    403 `FORBIDDEN` as an unknown or disabled staff id, so a caller cannot
 *    probe which staff ids exist.
 *
 * Hence this function checks only PRESENCE of `x-actor`, not its
 * `staff:<uuid>` shape - the contract's `internalMutationHeadersSchema`
 * (whose `x-actor` member carries that regex) still owns the shape, and
 * `resolveStaffActor` applies it via `parseActorHeader`. `idempotency-key`
 * IS shape-checked here (length bounds), since a key is a request-framing
 * concern with no authorization dimension at all.
 */
export function parseMutationHeaders(req: FastifyRequest): {
  idempotencyKey: string;
  actor: string;
} {
  const parsed = mutationHeaderPresenceSchema.parse({
    'idempotency-key': req.headers['idempotency-key'],
    'x-actor': req.headers['x-actor'],
  });
  return { idempotencyKey: parsed['idempotency-key'], actor: parsed['x-actor'] };
}

export function mapInternalError(err: unknown): unknown {
  return err instanceof z.ZodError ? new InternalValidationError('Invalid request.') : err;
}

export function sendUnauthorized(reply: FastifyReply, requestId: string): void {
  sendError(reply, requestId, new InternalUnauthorizedError());
}

export interface TopupRow {
  id: string;
  clientId: string;
  /** PAISE, bigint - this value feeds `creditWalletInTx` and becomes real money in `wallet_ledger`; never round-trip it through `Number()`. */
  amountMinor: bigint;
  status: 'pending' | 'approved' | 'rejected';
  /** The row's own `created_at`, ISO string - `undefined` for callers that never select it (`readTopupForDecision`/`readTopupAmountMinor` don't need it). */
  createdAt?: string;
}

interface RawTopupRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  amount_minor: string;
  status: 'pending' | 'approved' | 'rejected';
  /** Native `Date` (no `::text` cast) - same convention as `routes/impersonation-revoke-list.ts`'s `row.created_at.toISOString()`. */
  created_at?: Date;
}

function mapTopupRow(row: RawTopupRow): TopupRow {
  return {
    id: row.id,
    clientId: row.client_id,
    amountMinor: BigInt(row.amount_minor),
    status: row.status,
    ...(row.created_at !== undefined ? { createdAt: row.created_at.toISOString() } : {}),
  };
}

/**
 * The single staff-facing `topup_requests` read used by the approve/reject
 * decision path (`routes/topups.ts`): returns `amountMinor` as a `bigint`
 * parsed from `amount_minor::text`, NEVER through `Number()` - this value
 * feeds `creditWalletInTx` and becomes real money in `wallet_ledger`, so a
 * float round-trip would silently corrupt amounts past
 * `Number.MAX_SAFE_INTEGER` (guarded by
 * `modules/wallet/wallet-edge-cases-p19.integration.test.ts`). Returns
 * `undefined` when no such row exists - the caller decides whether that is
 * a `TopupNotFoundError`. `forUpdate` takes the row lock the approve path
 * needs to serialise two concurrent decisions on the same request.
 */
export async function readTopupForDecision(
  db: AdminAppQueryable,
  id: string,
  forUpdate = false,
): Promise<TopupRow | undefined> {
  const result = await db.query<RawTopupRow>(
    `SELECT id, client_id, amount_minor::text AS amount_minor, status
       FROM topup_requests
      WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapTopupRow(row) : undefined;
}

/**
 * Flips ONE `topup_requests` row to `approved`/`rejected`, keyed on its own
 * primary key and CONDITIONAL on `status = 'pending'` (state transitions via
 * conditional UPDATE - `.claude/rules/database.md`). Returns the number of
 * rows actually transitioned, so a caller can distinguish "I moved it" from
 * "someone already decided it" without a second read.
 *
 * `wp_app` has NO update grant on this table at all (migration 0058), so
 * this statement is only reachable under `wp_admin_app` - which is why every
 * caller runs it inside `withStaffMutation`'s `tx.asAdminRole(...)`.
 */
export async function markTopupDecided(
  db: AdminAppQueryable,
  input: { id: string; status: 'approved' | 'rejected'; staffId: string; reason: string },
): Promise<number> {
  const result = await db.query(
    // `SET` stays on the `UPDATE` line: the `wp/no-plain-set` guard matches a
    // line-leading `SET `, which a wrapped clause would trip.
    `UPDATE topup_requests SET status = $2, reviewed_by_staff_id = $3,
            review_reason = $4, reviewed_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [input.id, input.status, input.staffId, input.reason],
  );
  return result.rowCount ?? 0;
}

/** Reads ONE `topup_requests` row's amount by primary key, as a `bigint` (never `Number()`) - the reject path's notification payload. */
export async function readTopupAmountMinor(
  db: AdminAppQueryable,
  id: string,
): Promise<bigint | undefined> {
  const result = await db.query<{ amount_minor: string }>(
    `SELECT amount_minor::text AS amount_minor FROM topup_requests WHERE id = $1`,
    [id],
  );
  const raw = result.rows[0]?.amount_minor;
  return raw === undefined ? undefined : BigInt(raw);
}

/** Bounded (LIMIT 200) staff queue read, one status at a time - the internal API's own read surface, run under `wp_admin_app` (see `staff-audit.ts#withAdminAppRole`). */
export async function readTopupsByStatus(
  db: AdminAppQueryable,
  status: string,
): Promise<TopupRow[]> {
  const result = await db.query<RawTopupRow>(
    `SELECT id, client_id, amount_minor::text AS amount_minor, status, created_at
       FROM topup_requests
      WHERE status = $1
      ORDER BY created_at ASC
      LIMIT 200`,
    [status],
  );
  return result.rows.map(mapTopupRow);
}
