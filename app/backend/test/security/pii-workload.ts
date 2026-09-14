import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry, type MetricsRegistry } from '@wp/server-kit';
import { OptOutCandidateText, waJidFromE164 } from '@wp/domain';
import { createRedis, resolveRedisUrl } from '../../src/platform/redis.js';
import { resolveDatabaseUrl } from '../../src/platform/db/db-url.js';
import { hashRecipient } from '../../src/platform/crypto/phone-hash.js';
import {
  buildMessagesApp,
  buildTestConfig,
  cleanupMessagesRecords,
  seedInstance,
  seedPlanForClient,
} from '../../src/modules/messages/enqueue-test-support.js';
import { bindInboundMetrics } from '../../src/modules/inbound/metrics.js';
import { handleInboundMessageSignals } from '../../src/modules/inbound/message-signals.js';
import {
  createPairingController,
  type PairingSocketHandle,
} from '../../src/engine/session/pairing.js';
import { creditWallet } from '../../src/modules/wallet/credit.repo.js';
import { provisioningRepo } from '../../src/modules/tenancy/index.js';
import { onboardSentinelClient } from './pii-workload-onboard.js';
import { makeWorkloadKeyProvider, type Sentinels } from './pii-workload-sentinels.js';

export type { Sentinels } from './pii-workload-sentinels.js';
export { makeSentinels, allSentinelForms } from './pii-workload-sentinels.js';

/**
 * pii-workload.ts (P25 U7 Part B) - shared seed/workload helpers for
 * `log-grep-pii.integration.test.ts`. Reuses `enqueue-test-support.ts`'s
 * `buildMessagesApp` (the real production app, messages route included) so
 * `POST /v1/messages` is exercised for real rather than through a
 * never-called stub `keyProvider` (`tenancy-routes-test-support.ts`'s own
 * fixture deliberately throws if messages is ever hit). The sentinel-value
 * factory and the opt-out-pepper key-ring fixture live in the sibling
 * `pii-workload-sentinels.ts` (max-lines split) and are re-exported here so
 * the test file needs only one import. NOT itself a test file (no
 * `.test.ts` suffix), same convention as every other `*-test-support.ts` in
 * this tree.
 */

export interface WorkloadHandles {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redis: ReturnType<typeof createRedis>;
  app: FastifyInstance;
  sentVerificationUrls: Map<string, string>;
  registry: MetricsRegistry;
  createdUserIds: string[];
  createdClientIds: string[];
  createdPlanIds: string[];
}

export async function buildWorkloadHandles(): Promise<WorkloadHandles> {
  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pii-gate-test',
  });
  const tenantDb = createTenantDb(pool);
  const redis = createRedis(resolveRedisUrl());
  const sentVerificationUrls = new Map<string, string>();
  const config = buildTestConfig();
  const app = await buildMessagesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
  return {
    pool,
    tenantDb,
    redis,
    app,
    sentVerificationUrls,
    registry: createMetricsRegistry(),
    createdUserIds: [],
    createdClientIds: [],
    createdPlanIds: [],
  };
}

export async function closeWorkloadHandles(handles: WorkloadHandles): Promise<void> {
  await handles.app.close();
  // The inbound-signal workload step touches `instance_recipient_contacts`
  // (via `handleInboundMessageSignals`'s own touch-inbound-contact.sql UPSERT),
  // `contacts`, and (a genuine STOP match) `opt_outs`/`optout_confirmations` -
  // none of those are on `cleanupMessagesRecords`'s own delete list (that
  // helper was written before this suite's inbound-signal step existed), so
  // all are deleted here FIRST, before that helper deletes `whatsapp_
  // instances`, or the FK to `instance_recipient_contacts` blocks it.
  if (handles.createdClientIds.length > 0) {
    await handles.pool.query('DELETE FROM optout_confirmations WHERE client_id = ANY($1)', [
      handles.createdClientIds,
    ]);
    await handles.pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [
      handles.createdClientIds,
    ]);
    await handles.pool.query('DELETE FROM instance_recipient_contacts WHERE client_id = ANY($1)', [
      handles.createdClientIds,
    ]);
    await handles.pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [
      handles.createdClientIds,
    ]);
  }
  await cleanupMessagesRecords(
    handles.pool,
    handles.redis,
    handles.createdUserIds,
    handles.createdClientIds,
    handles.createdPlanIds,
  );
  handles.redis.disconnect();
  await handles.pool.end();
}

interface HttpJsonBody {
  data: Record<string, unknown>;
}

function expectOk(response: { statusCode: number; body: string }, label: string): HttpJsonBody {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${label} failed: ${response.statusCode} ${response.body}`);
  }
  return JSON.parse(response.body) as HttpJsonBody;
}

export interface TenantWorkloadResult {
  clientId: string;
  userId: string;
  mfaAccessToken: string;
}

/** Runs the full per-tenant workload (steps 1-6 of the dispatch): signup/verify/login/MFA/onboarding, POST /v1/messages, inbound signal, QR, wallet credit, disallowed audit metadata. */
export async function runTenantWorkload(
  handles: WorkloadHandles,
  sentinels: Sentinels,
): Promise<TenantWorkloadResult> {
  const { userId, clientId, mfaAccessToken } = await onboardSentinelClient(
    handles.app,
    handles.sentVerificationUrls,
    sentinels,
  );
  handles.createdUserIds.push(userId);
  handles.createdClientIds.push(clientId);

  const planId = await seedPlanForClient(handles.pool, clientId);
  handles.createdPlanIds.push(planId);
  const instanceId = await seedInstance(handles.pool, clientId);

  // (2) POST /v1/messages with the sentinel body to the sentinel phone.
  expectOk(
    await handles.app.inject({
      method: 'POST',
      url: `/v1/messages?instanceId=${instanceId}`,
      headers: {
        authorization: `Bearer ${mfaAccessToken}`,
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: {
        kind: 'text',
        recipient: sentinels.phoneE164,
        payload: { text: sentinels.bodyText },
        priority: 'normal',
      },
    }),
    'sentinel enqueue message',
  );

  // (3) one inbound signal carrying the body sentinel through the real
  // production entry point. A live contact + a genuine STOP match makes
  // `optedOut !== undefined`, and a THROWING `onOptedOut` port exercises the
  // real `message-signals.ts` error-log call site (client_id/instance_id/
  // error_class only, never the sender/body) - the one call in this whole
  // happy-path workload that legitimately logs with a seeded client id,
  // proving the redaction pipeline against REAL production output rather
  // than a log call fabricated for this test.
  const keyProvider = makeWorkloadKeyProvider();
  const inboundMetrics = bindInboundMetrics(handles.registry);
  const phoneHash = hashRecipient(keyProvider, sentinels.phoneE164);
  await handles.pool.query(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, addressing_mode, source)
     VALUES ($1, $2, $3, $4, 'pn', 'manual')`,
    [clientId, sentinels.phoneE164, phoneHash, waJidFromE164(sentinels.phoneE164)],
  );
  const candidate = OptOutCandidateText.fromPlainText(`STOP ${sentinels.bodyText}`);
  await handleInboundMessageSignals(
    {
      tenantDb: handles.tenantDb,
      clientId,
      instanceId,
      keyProvider,
      metrics: inboundMetrics,
      metricsRegistry: handles.registry,
      mirror: async () => ({ contactsUpdated: 0 }),
      onOptedOut: async () => {
        throw new Error('pii-gate workload: deliberate onOptedOut failure (probe)');
      },
    },
    { senderJid: waJidFromE164(sentinels.phoneE164), candidate },
  );

  // (4) one QR publish through the real pairing controller.
  const publishedEvents: unknown[] = [];
  const pairingController = createPairingController({
    repoCtx: {
      incrementQrAttempts: async () => ({ qr_attempts: 1, pairing_started_at: new Date() }),
      markPairingExpired: async () => {},
    },
    publish: (event) => {
      publishedEvents.push(event);
    },
    clock: { now: () => Date.now() },
    clientId,
    instanceId,
  });
  const fakeHandle: PairingSocketHandle = {
    sock: { end: () => {} },
    teardownWithRelease: async () => {},
  };
  await pairingController.onQr(fakeHandle, sentinels.qrPayload);

  // (5) one wallet credit carrying the external-ref sentinel.
  await handles.tenantDb.withTenant(clientId, (tx) =>
    creditWallet(tx, {
      clientId,
      amountMinor: 1000n,
      kind: 'promo_credit',
      reason: 'pii-gate sentinel credit',
      externalRef: sentinels.extRef,
      staffId: randomUUID(),
    }),
  );

  // (6) one audit-log insert whose metadata carries disallowed keys holding
  // sentinels - the allow-list must drop them.
  await handles.tenantDb.withTenant(clientId, (tx) =>
    provisioningRepo.insertAuditLog(tx, {
      clientId,
      actorType: 'system',
      action: 'pii_gate.probe',
      metadata: { reason: 'ok', phone: sentinels.phoneE164, body: sentinels.bodyText },
    }),
  );

  return { clientId, userId, mfaAccessToken };
}
