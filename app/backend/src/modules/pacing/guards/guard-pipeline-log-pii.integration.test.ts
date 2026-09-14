import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { createLogger, createMetricsRegistry } from '@wp/server-kit';
import * as serverKit from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { detectInboundOptOut } from '../../inbound/optout-detect.js';
import { bindInboundMetrics } from '../../inbound/metrics.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  captureStream,
  makeGuardPiiKeyProvider,
  seedGuardPiiQueuedJob,
} from './__tests__/guard-pipeline-log-pii-test-support.js';

/**
 * guard-pipeline-log-pii.integration.test.ts (P14 Unit U7, mandatory test
 * 32 extension) - runs an opt-out cancel, a blocked-word disposal, a
 * frequency deferral, and the unattributable-@lid path with log capture ON
 * (the shared `@wp/server-kit` `logger` singleton, replaced with a real
 * `createLogger(captureStream)` instance the SAME way `sse-log-redaction.
 * test.ts` does - the guard pipeline itself (`pipeline.ts`, `blocked-
 * words.ts`, `recipient-frequency.ts`) logs nothing at all today, so this is
 * primarily a negative-control proof: even with every scenario driven
 * end-to-end through real code and a real captured logger, no E.164, no
 * JID, no contact name, and no message body/blocked-word text ever appears
 * in a captured log line - and the one metric this phase's inbound module
 * exposes (`wp_optout_unattributable_total`) carries no label at all, so
 * there is nothing for a `reason`-only allow-list to even violate. Fixture
 * helpers live in the sibling `guard-pipeline-log-pii-test-support.ts` (max-
 * lines split, see that file's own doc).
 *
 * NEGATIVE CONTROL (P07 lesson, same discipline as `pairing-redaction.
 * integration.test.ts`): a sentinel string is written through the same
 * capture mechanism first, proving the scanner can actually find a match,
 * before being excluded from the real assertions.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'guard-pii-log-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM tenant_blocked_words WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('guard pipeline log/metric PII (P14 Unit U7, mandatory test 32 extension)', () => {
  it('no_pii_or_blocked_word_appears_in_captured_logs_or_metric_labels', async () => {
    const { stream, lines } = captureStream();
    const capturingLogger = createLogger(stream);
    vi.spyOn(serverKit, 'logger', 'get').mockReturnValue(capturingLogger);

    const sentinel = `sentinel-${randomUUID()}`;
    capturingLogger.info({}, `probe line carrying ${sentinel}`);
    expect(lines().some((line) => line.includes(sentinel))).toBe(true);

    const provider = makeGuardPiiKeyProvider();
    const registry = createMetricsRegistry();
    const { optOutUnattributableTotal } = bindInboundMetrics(registry);

    // --- Scenario 1: opt-out cancel -----------------------------------
    const { clientId: optOutClientId, instanceId: optOutInstanceId } = await seedSendTenant(
      pool,
      probeClientIds,
    );
    const optOutE164 = '+15557001111';
    await tenantDb.withTenant(optOutClientId, async (tx: TenantQueryable) => {
      await detectInboundOptOut(
        // No contacts mirror wiring needed in this suite - it proves PII
        // never leaks into logs, not the P20 mirror port.
        { tx, provider, mirror: async () => ({ contactsUpdated: 0 }) },
        {
          clientId: optOutClientId,
          instanceId: optOutInstanceId,
          senderJid: `${optOutE164.replace(/^\+/u, '')}@s.whatsapp.net`,
          senderE164: optOutE164,
          text: 'STOP',
          tenantKeywords: [],
        },
      );
    });

    // --- Scenario 2: blocked-word disposal ------------------------------
    const { clientId: blockedClientId, instanceId: blockedInstanceId } = await seedSendTenant(
      pool,
      probeClientIds,
    );
    const blockedWord = 'super secret embargoed phrase';
    const blockedRecipientHash = Buffer.from('guard-pii-blocked-recipient');
    await pool.query(`INSERT INTO tenant_blocked_words (client_id, word) VALUES ($1, $2)`, [
      blockedClientId,
      blockedWord,
    ]);
    const blockedJobId = await seedGuardPiiQueuedJob(
      pool,
      blockedClientId,
      blockedInstanceId,
      '+15557002222',
      blockedRecipientHash,
      `This message contains our ${blockedWord} today`,
    );

    // --- Scenario 3: frequency deferral ---------------------------------
    const { clientId: freqClientId, instanceId: freqInstanceId } = await seedSendTenant(
      pool,
      probeClientIds,
    );
    const freqRecipientHash = Buffer.from('guard-pii-frequency-recipient');
    // safe_default's per_recipient_24h is 3 (migration 0040 seed
    // correction) - three prior buckets already at the limit.
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, $3, 1)`,
        [freqClientId, freqRecipientHash, new Date(claimClock.now() - (i + 1) * 60 * 60 * 1000)],
      );
    }
    const freqJobId = await seedGuardPiiQueuedJob(
      pool,
      freqClientId,
      freqInstanceId,
      '+15557003333',
      freqRecipientHash,
      'A perfectly ordinary follow-up message',
    );

    const claimFn = claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
    await claimFn(
      { clientId: blockedClientId, sql: pool },
      {
        instanceId: blockedInstanceId,
        band: 3,
        fence: 1,
        workerId: 'guard-pii-blocked-worker',
        claimExpiryMs: 90_000,
      },
    );
    await claimFn(
      { clientId: freqClientId, sql: pool },
      {
        instanceId: freqInstanceId,
        band: 3,
        fence: 1,
        workerId: 'guard-pii-freq-worker',
        claimExpiryMs: 90_000,
      },
    );

    const blockedRow = await pool.query<{ status: string; pacing_deny_reason: string | null }>(
      'SELECT status, pacing_deny_reason FROM message_jobs WHERE id = $1',
      [blockedJobId],
    );
    expect(blockedRow.rows[0]?.pacing_deny_reason).toBe('BLOCKED_WORD');
    const freqRow = await pool.query<{ status: string; pacing_deny_reason: string | null }>(
      'SELECT status, pacing_deny_reason FROM message_jobs WHERE id = $1',
      [freqJobId],
    );
    expect(freqRow.rows[0]?.pacing_deny_reason).toBe('PER_RECIPIENT_FREQ');

    // --- Scenario 4: unattributable @lid-only sender --------------------
    const { clientId: lidClientId, instanceId: lidInstanceId } = await seedSendTenant(
      pool,
      probeClientIds,
    );
    const lidJid = `${randomUUID().replaceAll('-', '')}@lid`;
    await tenantDb.withTenant(lidClientId, async (tx: TenantQueryable) => {
      const result = await detectInboundOptOut(
        { tx, provider, metricsRegistry: registry, mirror: async () => ({ contactsUpdated: 0 }) },
        {
          clientId: lidClientId,
          instanceId: lidInstanceId,
          senderJid: lidJid,
          senderE164: null,
          text: 'STOP',
          tenantKeywords: [],
        },
      );
      expect(result.attributed).toBe(false);
    });
    expect(await registry.metricsText()).toContain('wp_optout_unattributable_total 1');
    void optOutUnattributableTotal;

    // ---- Assertions ----
    const capturedLines = lines().filter((line) => !line.includes(sentinel));
    const pii = [
      optOutE164,
      optOutE164.replace(/^\+/u, ''),
      blockedWord,
      lidJid,
      '+15557002222',
      '+15557003333',
    ];
    for (const line of capturedLines) {
      for (const value of pii) {
        expect(line).not.toContain(value);
      }
    }

    const metricsText = await registry.metricsText();
    for (const value of pii) {
      expect(metricsText).not.toContain(value);
    }
    // The one metric this module exposes carries no label at all - nothing
    // for a `reason`-only allow-list to violate.
    expect(metricsText).not.toMatch(/wp_optout_unattributable_total\{/);
  });
});
