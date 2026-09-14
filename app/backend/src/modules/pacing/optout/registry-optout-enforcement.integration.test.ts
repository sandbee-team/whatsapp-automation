import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { dispatch } from '../../../engine/queue/dispatch.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedClaimedJob } from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createFakeTransport } from '../../../provider/__test-support__/fake-transport.js';
import { reserve } from '../../../engine/pacing/index.js';
import {
  createMessage,
  RecipientOptedOutError,
  type CreateMessageServiceInput,
} from '../../messages/messages.service.js';
import { evaluateOptOutGate } from '../guards/optout-gate.js';
import { hashRecipient } from '../../../platform/crypto/phone-hash.js';
import { recordOptOut } from './registry.js';

/**
 * registry-optout-enforcement.integration.test.ts (P14 Unit U4, step 7) -
 * real Postgres. Split out of `registry.integration.test.ts` purely for
 * that file's max-lines cap (same established split idiom as
 * `send-loop-pacing-claim.ts` etc.) - `registry.integration.test.ts` keeps
 * its own original THREE mandatory cases (P14 Unit U3) untouched; this
 * file adds mandatory test 16 (amended, P14 Unit U4's three enforcement
 * points). The 30-day confirmation guard and [R-3s] (an exempt reserve
 * still defers to the sending window) live in the further siblings
 * `optout-confirmation-thirty-day-guard.integration.test.ts` and
 * `optout-confirmation-window-deferral.integration.test.ts`.
 */

function makeOptoutKeyProvider(ringPath: string): FileKeyProvider {
  return new FileKeyProvider({ ringPath, mountedPurposes: ['optout-pepper'] });
}

/** Builds a `FileKeyProvider` with a distinct kekId per purpose (avoids the "same kekId, different purpose" schema rejection) - same shape as registry.integration.test.ts's own copy. */
function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-optout-enforcement-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0c).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

async function getJobStatus(
  testPool: TestPool,
  jobId: string,
): Promise<{ status: string; cancel_reason: string | null; attempts: number }> {
  const result = await testPool.query<{
    status: string;
    cancel_reason: string | null;
    attempts: number;
  }>('SELECT status, cancel_reason, attempts FROM message_jobs WHERE id = $1', [jobId]);
  const row = result.rows[0];
  if (!row) throw new Error(`getJobStatus: no message_jobs row with id ${jobId}`);
  return row;
}

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-enforcement-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('opt-out enforcement points (P14 Unit U4, real Postgres)', () => {
  it('optout_hard_blocks_at_all_three_points', async () => {
    // Mandatory test 16, amended (P14 Unit U4): three independent
    // enforcement points over the SAME isOptedOut lookup.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query(`UPDATE whatsapp_instances SET link_state = 'linked' WHERE id = $1`, [
      instanceId,
    ]);
    const provider = makeOptoutKeyProvider(makeOptoutPepperRing());
    const phoneHash = hashRecipient(provider, '+15550004444');
    const tenantDb = createTenantDb(pool);

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        // No contacts seeded in this suite - the no-op fake is correct here
        // (the P20 mirror is proved for real in optout-mirror.integration.test.ts).
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
    });

    // (a) enqueue-time: createMessage -> 422 RECIPIENT_OPTED_OUT, zero new
    // message_jobs rows, zero wallet mutations.
    const walletBefore = await pool.query(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    const jobsBefore = await pool.query(
      'SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1',
      [clientId],
    );
    const input: CreateMessageServiceInput = {
      clientId,
      instanceId,
      idempotencyKey: `optout-precheck-${randomUUID()}`,
      requestBody: {},
      recipient: { jid: '15550004444@s.whatsapp.net', e164: '+15550004444' },
      payload: { text: 'hi' },
      payloadKind: 'text',
      priority: 'normal',
      scheduledAt: null,
      sendOrigin: 'api_send',
    };
    await expect(createMessage(tenantDb, input, { keyProvider: provider })).rejects.toBeInstanceOf(
      RecipientOptedOutError,
    );
    const jobsAfter = await pool.query(
      'SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1',
      [clientId],
    );
    expect(jobsAfter.rows[0]?.n).toBe(jobsBefore.rows[0]?.n);
    const walletAfter = await pool.query(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(walletAfter.rows[0]).toEqual(walletBefore.rows[0]);

    // (b) claim-pipeline guard: a job queued BEFORE the opt-out (seeded
    // directly, bypassing the now-blocking enqueue path) is blocked by
    // evaluateOptOutGate for 'api_send' AND the pacing-exempt 'system_reply'.
    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const apiSend = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'api_send',
      });
      expect(apiSend).toEqual({ ok: false, reason: 'OPT_OUT', retryAt: null });

      const systemReply = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'system_reply',
      });
      expect(systemReply).toEqual({ ok: false, reason: 'OPT_OUT', retryAt: null });

      const confirmation = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'opt_out_confirmation',
      });
      expect(confirmation).toEqual({ ok: true });
    });

    // (c) pre-send precheck: a job already claimed ('processing', simulating
    // a stale-cache worker that claimed before the opt-out landed) is
    // cancelled by dispatch()'s precheck - no send_attempts row, no attempts
    // increment, and the pacing unit it holds is refunded post-commit.
    const claimed = await seedClaimedJob(pool, { clientId, instanceId });
    const reserveOutcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: { now: () => Date.now() },
      timeZone: 'UTC',
    });
    if (!reserveOutcome.granted) throw new Error('test setup: expected a pacing grant');
    const ledgerBefore = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );

    const transport = createFakeTransport();
    const result = await dispatch(
      {
        clientId,
        instanceId,
        jobId: claimed.id,
        jobCreatedAt: claimed.createdAt,
        leaseId: claimed.leaseId,
        attempts: 0,
        recipientJid: '15550004444@s.whatsapp.net',
        payloadKind: 'text',
        payload: { text: 'hi' },
        publicId: claimed.publicId,
        fence: 1,
        recipientHash: phoneHash,
        sendOrigin: 'api_send',
        pacingReserve: {
          ledgerDate: reserveOutcome.ledgerDate,
          gapMs: 0,
          isNewConversation: false,
          isGroup: false,
          isExempt: false,
        },
      },
      { tenantDb, transport, clock: { now: () => Date.now() } },
    );

    expect(result.outcome).toBe('cancelled_pre_send');
    expect(transport.calls.length).toBe(0);

    const cancelledStatus = await getJobStatus(pool, claimed.id);
    expect(cancelledStatus.status).toBe('cancelled');
    expect(cancelledStatus.cancel_reason).toBe('opt_out');
    expect(cancelledStatus.attempts).toBe(0);

    const attemptRows = await pool.query('SELECT id FROM send_attempts WHERE message_job_id = $1', [
      claimed.id,
    ]);
    expect(attemptRows.rowCount).toBe(0);

    const ledgerAfter = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    expect(ledgerAfter.rows[0]?.consumed_count).toBe(
      (ledgerBefore.rows[0]?.consumed_count ?? 0) - 1,
    );
  });
});
