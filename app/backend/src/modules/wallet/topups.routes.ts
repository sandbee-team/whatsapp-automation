import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantDb } from '@wp/db';
import {
  createMessageHeadersSchema,
  createTopupRequestInputSchema,
  listTopupRequestsInputSchema,
} from '@wp/contracts';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import {
  bindWalletMetrics,
  type WalletMetricsHandles,
} from '../../platform/metrics/wallet-metrics.js';
import {
  createTopupRequest,
  listTopupRequests,
  readTopupRequest,
  type TopupRequestRow,
} from './topups.repo.js';

/**
 * topups.routes.ts (P19 Unit U4, step 7/10/11) - the TENANT top-up API:
 * `POST /v1/wallet/topup-requests` (`policy: 'session_mfa'` - a money-
 * adjacent mutation, same policy tier `POST /v1/messages` uses) and
 * `GET /v1/wallet/topup-requests` (`policy: 'session'` - a read). Both
 * scope to `req.auth!.clientId` ONLY, never a body/query field (binding
 * correction #9).
 *
 * MANDATORY Idempotency-Key (binding correction #10): parsed via the SAME
 * `createMessageHeadersSchema` `messages.routes.ts:53` already uses -
 * missing/blank fails Zod validation BEFORE any DB call, mapped to `400
 * VALIDATION_ERROR`. This is a header-presence gate, not a second dedupe
 * mechanism - `topup_requests_client_external_ref_key` (the tenant-typed
 * UTR) is the actual duplicate-submission authority, enforced purely at the
 * database: this route never runs a pre-check SELECT before the INSERT: it
 * always attempts `createTopupRequest` and catches Postgres `23505` on that
 * exact constraint, mapping it to `409 CONFLICT` (never a plain in-memory
 * `find` first - the test for this greps the route body for that absence).
 */

export interface TopupsRoutesDeps {
  tenantDb: TenantDb;
  metrics?: Pick<WalletMetricsHandles, 'incTopup'>;
}

class TopupsValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'TopupsValidationError';
  }
}

class TopupDuplicateExternalRefError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('A top-up request with this reference number already exists.');
    this.name = 'TopupDuplicateExternalRefError';
  }
}

class TopupRequestNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('Top-up request not found.');
    this.name = 'TopupRequestNotFoundError';
  }
}

function isDuplicateExternalRef(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === 'topup_requests_client_external_ref_key'
  );
}

function toItem(row: TopupRequestRow): {
  id: string;
  amountMinor: string;
  status: TopupRequestRow['status'];
  createdAt: string;
} {
  // Wire boundary: PAISE serialises as a decimal STRING, never a JSON
  // number (JSON.stringify throws on a bigint, and a JS number cannot
  // represent every bigint-range amount exactly) - see topupRequestItemSchema.
  return {
    id: row.id,
    amountMinor: row.amountMinor.toString(),
    status: row.status,
    createdAt: row.createdAt,
  };
}

function mapValidation(err: unknown): unknown {
  return err instanceof z.ZodError ? new TopupsValidationError('Invalid request.') : err;
}

export function registerTopupsRoutes(
  app: FastifyInstance,
  deps: TopupsRoutesDeps,
  authDeps: AuthDeps,
): void {
  const metrics = deps.metrics ?? bindWalletMetrics();

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/wallet/topup-requests',
    policy: 'session_mfa',
    scope: 'wallet:topup:create',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        // Mandatory Idempotency-Key - parsed/validated BEFORE any write
        // (binding correction #10). The header's own value is not
        // persisted here (external_ref is the durable dedupe key); this
        // parse's only job is the fail-closed presence/shape gate.
        createMessageHeadersSchema.parse(req.headers);
        const input = createTopupRequestInputSchema.parse(req.body);

        let row: TopupRequestRow;
        try {
          row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
            createTopupRequest(tx, {
              clientId: auth.clientId,
              // input.amountMinor is a Zod-validated safe-integer JS number
              // (the tenant-typed rupee amount, ADR 0019 S9 v1 scope, far
              // below Number.MAX_SAFE_INTEGER for any real top-up) - BigInt()
              // is exact for it. The repo's own type is bigint end-to-end
              // from here on, never re-widened back to number.
              amountMinor: BigInt(input.amountMinor),
              method: input.method,
              externalRef: input.externalRef,
              submittedByUserId: auth.userId,
            }),
          );
        } catch (err) {
          if (isDuplicateExternalRef(err)) {
            throw new TopupDuplicateExternalRefError();
          }
          throw err;
        }

        metrics.incTopup(row.status);
        sendSuccess(reply, requestId, toItem(row), 201);
      } catch (err) {
        sendError(reply, requestId, mapValidation(err));
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/wallet/topup-requests',
    policy: 'session',
    scope: 'wallet:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const input = listTopupRequestsInputSchema.parse(req.query);
        const cursor = input.cursor ? decodeListCursor(input.cursor) : undefined;

        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          listTopupRequests(tx, { clientId: auth.clientId, limit: input.limit, cursor }),
        );

        sendSuccess(reply, requestId, result.items.map(toItem));
      } catch (err) {
        sendError(reply, requestId, mapValidation(err));
      }
    },
  });

  // Single-item read (contract addition, see wallet.ts's own doc comment):
  // a tenant probing another tenant's id gets a 404 - readTopupRequest's
  // own WHERE client_id = $1 AND id = $2 predicate makes "not found" and
  // "not yours" the same, indistinguishable outcome (never a data leak
  // through a differing error).
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/wallet/topup-requests/:id',
    policy: 'session',
    scope: 'wallet:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const id = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);

        const row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          readTopupRequest(tx, auth.clientId, id),
        );
        if (!row) {
          throw new TopupRequestNotFoundError();
        }

        sendSuccess(reply, requestId, toItem(row));
      } catch (err) {
        sendError(reply, requestId, mapValidation(err));
      }
    },
  });
}

/**
 * Same opaque base64url `${createdAtIso}|${id}` shape as
 * `notifications.repo.ts#decodeCursor` - kept local (not re-exported)
 * since this route's own cursor never crosses a module boundary. A
 * malformed cursor is a typed VALIDATION_ERROR, never a raw SQL bind error.
 */
function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new TopupsValidationError('Invalid pagination cursor.');
  }
  const sepIndex = decoded.indexOf('|');
  if (sepIndex <= 0 || sepIndex === decoded.length - 1) {
    throw new TopupsValidationError('Invalid pagination cursor.');
  }
  const createdAt = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new TopupsValidationError('Invalid pagination cursor.');
  }
  return { createdAt, id };
}
