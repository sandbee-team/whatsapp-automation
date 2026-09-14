import { randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { signup } from '../signup.service.js';
import { verifyEmail, type VerifyEmailCtx } from '../verify-email.service.js';
import * as identityRepoDefault from '../identity.repo.js';

/**
 * verify-email-edge-cases.integration.test.ts (C2 hardening pass, P04b) -
 * one edge NOT covered by verify-email.integration.test.ts's own
 * concurrent-consume proof (which races two verifyEmail() calls on the SAME
 * token) or its sequential suspended-client proof (which suspends BEFORE
 * calling verifyEmail): a client whose status is flipped to `suspended`
 * mid-flow - AFTER the token claim/email-verify has already run inside the
 * open transaction, but BEFORE the `activateClientIfPending` UPDATE reads
 * the row - must still leave the client suspended (fail-safe: the
 * conditional `WHERE status = 'pending_verification'` sees the row AS IT IS
 * AT THAT POINT, and a suspend that lands first via a concurrent
 * transaction wins).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `verify-email-edge-${label}-${randomUUID()}@example.test`;
}

async function signupAndCaptureRawToken(
  label: string,
): Promise<{ userId: string; clientId: string; email: string; rawToken: string }> {
  const email = uniqueEmail(label);
  let capturedUrl = '';
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async (_to, verifyUrl) => {
        capturedUrl = verifyUrl;
      },
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    { fullName: `Verify Email Edge ${label}`, email, companyName: `Verify Email Edge Co ${label}` },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);

  const rawToken = new URL(capturedUrl).searchParams.get('token');
  if (!rawToken) throw new Error('signup did not produce a verification token URL');

  return { userId: result.userId, clientId: result.clientId, email, rawToken };
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
  }
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

describe('verifyEmail - client suspended mid-flow (between token claim and activation)', () => {
  it('a_client_suspended_by_a_concurrent_transaction_right_before_the_activation_update_stays_suspended', async () => {
    const { userId, clientId, rawToken } = await signupAndCaptureRawToken('suspend-mid-flow');

    const ctx: VerifyEmailCtx = {
      pool,
      identityRepo: {
        // Wraps the REAL activateClientIfPending, but suspends the client
        // via a SEPARATE, already-committed transaction immediately before
        // delegating - simulating an admin/ops suspension action that lands
        // in the narrow window between this transaction's earlier reads and
        // its activation UPDATE. The suspend uses its own connection so it
        // is durably committed (not just staged) before the activation
        // UPDATE runs inside verifyEmail's open transaction.
        activateClientIfPending: async (client: TenantQueryable, cid: string) => {
          await pool.query(`UPDATE clients SET status = 'suspended' WHERE id = $1`, [cid]);
          return identityRepoDefault.activateClientIfPending(client, cid);
        },
      },
    };

    const result = await verifyEmail(ctx, rawToken);
    expect(result.userId).toBe(userId);

    // The email verification itself still proceeds (never blocked by the
    // unrelated status change).
    const userRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    expect(userRow.rows[0]!.email_verified_at).not.toBeNull();

    // The client status stays suspended - the conditional
    // `WHERE status = 'pending_verification'` correctly sees zero matching
    // rows and never resurrects it, exactly as the fail-safe invariant
    // requires.
    const clientRow = await pool.query<{ status: string; onboarding_step: string }>(
      'SELECT status, onboarding_step FROM clients WHERE id = $1',
      [clientId],
    );
    expect(clientRow.rows[0]!.status).toBe('suspended');

    // The onboarding-step advance is independent of the activation
    // conditional (it has its own WHERE onboarding_step = 'verify_email')
    // and is NOT gated on client status - documenting the actual observed
    // behavior rather than assuming it.
    expect(clientRow.rows[0]!.onboarding_step).toBe('choose_timezone');
  });
});
