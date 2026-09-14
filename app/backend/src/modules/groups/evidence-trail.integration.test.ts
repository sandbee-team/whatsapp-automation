import { createHash, randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { cleanupWaGroups, seedWaGroup } from './__tests__/groups-test-helpers.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  ledgerFor,
  linkInstance,
  runOneIteration,
} from './__tests__/send-test-helpers.js';
import { recordInboundReceipt } from '../inbound/receipts.js';
import { bindInboundMetrics } from '../inbound/metrics.js';
import {
  buildEvidenceTrailBlock,
  runForbiddenPathForEvidence,
} from './__tests__/evidence-trail-format.js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * evidence-trail.integration.test.ts (P24 U7, step 10) - drives ONE real
 * group send through claim -> reserve -> dispatch (fake transport) ->
 * result, plus one `group_forbidden` send on a sibling enabled group of the
 * SAME instance, then prints one delimited ids/hashes/counts-only block for
 * `docs/evidence/P24-group-send.md` Part A. No new production code path -
 * only a reproducible capture, hard-asserted to never carry a subject/JID/
 * phone (last assertions below).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-evidence-trail-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('P24 evidence trail - one real group send + one group_forbidden path', () => {
  it('prints_the_verbatim_group_send_and_forbidden_trail_ids_hashes_counts_only', async () => {
    const keyProvider = buildGroupSendTestKeyProvider();
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const sendGroup = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 20,
    });
    const forbiddenGroup = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 8,
    });

    const ledgerBefore = await ledgerFor(pool, instanceId);

    // --- Part 1: one real group send through claim -> reserve -> dispatch -> resolveAck.
    const transport = createFakeTransport();
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    transport.queueResolve(0, waMsgId);
    const enqueued = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      sendGroup.groupJid,
    );
    const claimed = await runOneIteration(tenantDb, pool, { clientId, instanceId, transport });
    expect(claimed).toBe(true);

    const ledgerAfter = await ledgerFor(pool, instanceId);

    const jobId = await jobIdForPublicId(pool, clientId, enqueued.id);
    const jobRow = await pool.query<{
      status: string;
      last_error_class: string | null;
      recipient_e164: string | null;
      is_new_conversation: boolean;
    }>(
      `SELECT status, last_error_class, recipient_e164, is_new_conversation
         FROM message_jobs WHERE id = $1`,
      [jobId],
    );
    const jobPublicIdHash = sha256Hex(enqueued.id);
    const jobIdHash = sha256Hex(jobId);
    expect(jobRow.rows[0]?.status).toBe('sent');
    expect(jobRow.rows[0]?.recipient_e164).toBeNull();

    const attemptRows = await pool.query<{ id: string; attempt_no: number; state: string }>(
      `SELECT id, attempt_no, state FROM send_attempts WHERE message_job_id = $1 ORDER BY attempt_no`,
      [jobId],
    );
    const attemptLines = attemptRows.rows.map(
      (r) =>
        `  attempt_id_hash=${sha256Hex(r.id)} attempt_no=${String(r.attempt_no)} state=${r.state}`,
    );

    const sentEventRows = await pool.query<{ event_type: string; provider_event_id: string }>(
      `SELECT event_type, provider_event_id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2 ORDER BY created_at`,
      [clientId, jobId],
    );
    expect(sentEventRows.rows.length).toBeGreaterThanOrEqual(1);
    const sentEventLines = sentEventRows.rows.map(
      (r) =>
        `  event_type=${r.event_type} provider_event_id_sha256=${sha256Hex(r.provider_event_id)}`,
    );

    const walletLedgerRows = await pool.query<{ price_key: string; amount_minor: string }>(
      `SELECT price_key, amount_minor::text AS amount_minor FROM wallet_ledger WHERE client_id = $1 ORDER BY created_at`,
      [clientId],
    );
    expect(walletLedgerRows.rows).toHaveLength(1);
    expect(walletLedgerRows.rows[0]?.price_key).toBe('group_text');

    const walletGuardCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_charge_guards WHERE client_id = $1`,
      [clientId],
    );
    expect(walletGuardCount.rows[0]?.count).toBe('1');

    // --- Part 2: three synthetic participant receipts, same wa_msg_id - three distinct delivery_events rows.
    const registry = createMetricsRegistry();
    const inboundMetrics = bindInboundMetrics(registry);
    const receiptDeps = { tenantDb, clientId, instanceId, metrics: inboundMetrics };
    const participants = ['p1@s.whatsapp.net', 'p2@s.whatsapp.net', 'p3@s.whatsapp.net'];
    for (const participantJid of participants) {
      const outcome = await recordInboundReceipt(receiptDeps, {
        waMsgId,
        remoteJid: sendGroup.groupJid,
        eventType: 'delivered',
        eventTs: '1000',
        participantJid,
      });
      expect(outcome).toBe('recorded');
    }
    const receiptEventRows = await pool.query<{ provider_event_id: string }>(
      `SELECT provider_event_id FROM delivery_events
         WHERE client_id = $1 AND message_job_id = $2 AND event_type = 'delivered'`,
      [clientId, jobId],
    );
    expect(receiptEventRows.rows).toHaveLength(3);
    const receiptIdHashes = new Set(
      receiptEventRows.rows.map((r) => sha256Hex(r.provider_event_id)),
    );
    expect(receiptIdHashes.size).toBe(3);
    const receiptLines = [...receiptIdHashes].map(
      (h) => `  participant_receipt_provider_event_id_sha256=${h}`,
    );

    // --- Part 3: one group_forbidden path (+ dedupe replay) on a SIBLING enabled group.
    const forbidden = await runForbiddenPathForEvidence(
      pool,
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      forbiddenGroup.groupJid,
      forbiddenGroup.id,
    );
    expect(forbidden.instanceHealthStateAfter).toBe(forbidden.instanceHealthStateBefore);
    expect(forbidden.instancePauseReasonAfter).toBe(forbidden.instancePauseReasonBefore);
    expect(forbidden.groupSendEnabled).toBe(false);
    expect(forbidden.groupDisabledReason).toBe('group_forbidden');
    expect(forbidden.auditAction).toBe('group.send_disabled');
    expect(forbidden.replayDeduped).toBe(true);

    const j = jobRow.rows[0];
    const block = buildEvidenceTrailBlock(
      {
        jobPublicIdHash,
        jobIdHash,
        jobStatus: j?.status,
        jobLastErrorClass: j?.last_error_class,
        jobRecipientE164: j?.recipient_e164,
        jobIsNewConversation: j?.is_new_conversation,
        ledgerBefore,
        ledgerAfter,
        walletPriceKey: walletLedgerRows.rows[0]?.price_key,
        walletAmountMinor: walletLedgerRows.rows[0]?.amount_minor,
        walletGuardCount: walletGuardCount.rows[0]?.count,
        receiptDistinctCount: receiptIdHashes.size,
        groupIdHash: sha256Hex(forbidden.groupId),
        groupSendEnabled: forbidden.groupSendEnabled,
        groupDisabledReason: forbidden.groupDisabledReason,
        groupNextSyncAfterIsNotNull: forbidden.groupNextSyncAfterIsNotNull,
        auditAction: forbidden.auditAction,
        notificationsReplayDeduped: forbidden.replayDeduped,
        instanceHealthStateBefore: forbidden.instanceHealthStateBefore,
        instanceHealthStateAfter: forbidden.instanceHealthStateAfter,
        instancePauseReasonBefore: forbidden.instancePauseReasonBefore,
        instancePauseReasonAfter: forbidden.instancePauseReasonAfter,
      },
      attemptLines,
      sentEventLines,
      receiptLines,
    );
    console.log(block); // deliberate, delimited evidence capture - see module header.

    expect(block).not.toMatch(/@g\.us/);
    expect(block).not.toMatch(/@s\.whatsapp\.net/);
    expect(block).not.toMatch(/@lid/);
    // Strip every UUID and hex-digest token (both legitimately contain long
    // digit runs by chance) before checking for a bare long digit run - the
    // task's own bar is "no digit run longer than 6 outside UUIDs/hex".
    const withoutIdsAndHex = block
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      .replace(/[0-9a-f]{12,}/gi, '');
    expect(withoutIdsAndHex).not.toMatch(/\d{7,}/);
  });
});
