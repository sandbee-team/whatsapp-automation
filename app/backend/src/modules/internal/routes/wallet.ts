import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  creditClientWalletInputSchema,
  adjustClientWalletInputSchema,
  freezeClientWalletInputSchema,
  unfreezeClientWalletInputSchema,
} from '@wp/contracts';
import type { WalletState } from '@wp/domain';
import { creditWalletInTx, publishWakeForClient, type CreditKind } from '../../wallet/index.js';
import { applyFreezeOrUnfreeze } from './wallet-freeze-state.js';
import { notify } from '../../notifications/index.js';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import {
  assertInternalAccess,
  mapInternalError,
  parseMutationHeaders,
  sendUnauthorized,
} from '../internal-access.js';
import { computeRequestHash } from '../staff-audit.js';
import { withStaffMutation } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';

/**
 * routes/wallet.ts (P28 Unit U3a, step 4) - the staff wallet mutation
 * surface: `POST /internal/v1/clients/:id/wallet/{credit,adjust,freeze,
 * unfreeze}`. Every route: `assertInternalAccess` (IP allow-list + service
 * token) -> parse `internalMutationHeadersSchema` + the mount contract's
 * input schema (400 BEFORE any write) -> `withStaffMutation`. `credit`/
 * `adjust` run `creditWalletInTx` INSIDE `withStaffMutation`'s own
 * transaction so the credit and the audit row commit atomically together
 * (never a separate best-effort audit write, unlike the P19 stopgap).
 */

async function wakeAfterCommit(
  deps: InternalRoutesDeps,
  clientId: string,
  before: WalletState,
  after: WalletState,
): Promise<void> {
  const wasZeroClaim = before === 'empty' || before === 'frozen';
  const isNowClaimable = after === 'active' || after === 'low';
  if (!wasZeroClaim || !isNowClaimable) return;
  await deps.tenantDb.withTenant(clientId, (readTx) =>
    publishWakeForClient({ db: readTx, publishWake: deps.publishWake }, clientId),
  );
}

function registerMoneyRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  path: string,
  action: 'wallet.credit' | 'wallet.adjust',
): void {
  // Parsed per-action rather than through one union-typed schema: `adjust`'s
  // wire input has NO `kind` field at all (it is always `adjustment_credit`,
  // see the contract's own doc comment), so a union would type `body.kind`
  // as possibly-absent and invite an `as` cast on a value that decides which
  // ledger `kind` real money lands under.
  const parseBody = (
    raw: unknown,
  ): { reason: string; amountMinor: string; externalRef: string; kind: CreditKind } =>
    action === 'wallet.credit'
      ? creditClientWalletInputSchema.parse(raw)
      : { ...adjustClientWalletInputSchema.parse(raw), kind: 'adjustment_credit' };

  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: `internal:${action}`,
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        parseMutationHeaders(req);
        const clientId = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const body = parseBody(req.body);
        const kind = body.kind;
        // The hash covers the CANONICAL parsed body (including the derived
        // `kind`), so the same key replayed against `credit` and `adjust`
        // with an otherwise identical body is a mismatch, not a replay.
        const requestHash = computeRequestHash('POST', path, body);

        const result = await withStaffMutation(
          deps,
          req,
          {
            action,
            clientId,
            targetKind: 'client',
            targetRef: clientId,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            const creditResult = await creditWalletInTx(
              tx,
              { nowMs: (deps.now ? deps.now() : new Date()).getTime() },
              {
                clientId,
                amountMinor: BigInt(body.amountMinor),
                kind,
                reason: body.reason,
                externalRef: body.externalRef,
                staffId: tx.actor.staffId,
              },
            );

            if (!creditResult.replayed) {
              await notify(tx, {
                clientId,
                kind: 'wallet_credited_by_staff',
                transitionId: String(tx.auditId),
                payload: { amountMinor: body.amountMinor, kind },
              });
              tx.afterCommit(() =>
                wakeAfterCommit(deps, clientId, creditResult.stateBefore, creditResult.stateAfter),
              );
            }

            return { clientId, seq: creditResult.seq, state: creditResult.stateAfter };
          },
        );

        // Read the account's own current balance back for the response -
        // `creditWalletInTx`'s own result carries `seq`/`state` but not
        // `balanceMinor` (that repo call is frozen, owned by U2). A replay
        // reads the same, unchanged row - harmless.
        const balanceRow = await deps.tenantDb.withTenant(clientId, (readTx) =>
          readTx.query<{ balance_minor: string; state: WalletState }>(
            `SELECT balance_minor::text AS balance_minor, state FROM wallet_accounts WHERE client_id = $1`,
            [clientId],
          ),
        );
        const account = balanceRow.rows[0];

        sendSuccess(reply, requestId, {
          clientId,
          seq: result.data.seq,
          balanceMinor: account?.balance_minor ?? '0',
          state: account?.state ?? result.data.state,
          replayed: result.replayed,
        });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}

function registerFreezeOrUnfreezeRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  path: string,
  action: 'wallet.freeze' | 'wallet.unfreeze',
): void {
  const bodySchema =
    action === 'wallet.freeze' ? freezeClientWalletInputSchema : unfreezeClientWalletInputSchema;
  const notifyKind = action === 'wallet.freeze' ? 'wallet_frozen' : 'wallet_unfrozen';

  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: `internal:${action}`,
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        parseMutationHeaders(req);
        const clientId = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const body = bodySchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, body);

        const result = await withStaffMutation(
          deps,
          req,
          {
            action,
            clientId,
            targetKind: 'client',
            targetRef: clientId,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            // The freeze/unfreeze conditional UPDATE + (for unfreeze) the
            // `@wp/domain#nextWalletState` derivation live in the sibling
            // `wallet-freeze-state.ts` (300-line cap split; see that file's
            // own header for the boundary-derivation rationale, C1 review
            // round 2 MAJOR 1).
            const row = await applyFreezeOrUnfreeze(tx, clientId, action);
            const changed = row !== undefined;
            // No row matched (already in the target state, or - for
            // unfreeze - not currently frozen): `state` in the response is
            // still 'frozen' either way (freeze's own target, or unfreeze's
            // no-op leaving the wallet exactly as it was).
            const state: WalletState = row?.state ?? 'frozen';

            if (changed) {
              await notify(tx, {
                clientId,
                kind: notifyKind,
                transitionId: String(tx.auditId),
                payload: {},
              });
              if (action === 'wallet.unfreeze') {
                tx.afterCommit(() => wakeAfterCommit(deps, clientId, 'frozen', state));
              }
            }

            return { clientId, state, changed };
          },
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}

export function registerInternalWalletMutationRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerMoneyRoute(
    app,
    deps,
    authDeps,
    '/internal/v1/clients/:id/wallet/credit',
    'wallet.credit',
  );
  registerMoneyRoute(
    app,
    deps,
    authDeps,
    '/internal/v1/clients/:id/wallet/adjust',
    'wallet.adjust',
  );
  registerFreezeOrUnfreezeRoute(
    app,
    deps,
    authDeps,
    '/internal/v1/clients/:id/wallet/freeze',
    'wallet.freeze',
  );
  registerFreezeOrUnfreezeRoute(
    app,
    deps,
    authDeps,
    '/internal/v1/clients/:id/wallet/unfreeze',
    'wallet.unfreeze',
  );
}
