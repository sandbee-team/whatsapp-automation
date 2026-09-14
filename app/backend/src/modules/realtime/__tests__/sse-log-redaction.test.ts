import '../__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as serverKit from '@wp/server-kit';
import { createRealtimeHub } from '../hub.js';
import { bindRealtimeMetrics } from '../metrics.js';
import { createAuthzTick } from '../authz-tick.js';
import { subscribeConnection, failClosedInstanceOwnership, type RealtimeCtx } from '../service.js';
import type { AuthenticatedContext } from '../../../platform/http/route-policy.js';
import type { AuthzSnapshotRow } from '../authz.repo.js';
import type { TenantQueryable } from '@wp/db';
import {
  createCaptureStream,
  connectCapturingSink,
  assertNoLeak,
} from './sse-log-redaction-test-support.js';

const { createMetricsRegistry, ALLOWED_LOG_FIELDS, createLogger } = serverKit;

/**
 * sse-log-redaction.test.ts (P05 Unit U3b) - a seeded two-tenant scenario
 * (connect, a foreign-instance subscription refusal, one publish of each of
 * the six real-time event types, a slow-consumer drop, and one authz tick
 * that drops a user) run entirely through the real hub/service/metrics/
 * authz-tick code, with EVERY SSE frame, EVERY captured log line, and the
 * metrics text scanned for phone numbers, WhatsApp JIDs, and forbidden
 * field names. Also proves a caller that tries to smuggle a `phone` key
 * onto a published event THROWS and nothing is written anywhere.
 *
 * `service.ts`'s subscription-refusal log line goes through `@wp/server-
 * kit`'s SHARED `logger` singleton (no per-call injection point - see
 * logger.ts's own doc comment on why there is no `.child()`/instance
 * override). pino's DEFAULT destination (no stream passed to `createLogger`)
 * writes via `sonic-boom` directly to the fd, bypassing `process.stdout.
 * write` entirely - a `vi.spyOn(process.stdout, 'write')` never sees those
 * lines. So this test replaces the shared singleton's underlying writable
 * with a real `createLogger(captureStream)` instance via
 * `vi.spyOn(serverKit, 'logger', 'get')`, and drives every OTHER log call in
 * this scenario through that SAME captured logger too - one real logger
 * instance, one capture mechanism. Fixture helpers live in
 * sse-log-redaction-test-support.ts (kept out of this file purely to stay
 * under the repo's max-lines guard).
 */

describe('SSE frames + logs + metrics never carry a phone, JID, or body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no_sse_frame_or_log_line_carries_a_phone_jid_or_body', async () => {
    const { stream, lines, raw } = createCaptureStream();
    const capturingLogger = createLogger(stream);
    vi.spyOn(serverKit, 'logger', 'get').mockReturnValue(capturingLogger);
    const logger = capturingLogger;
    const registry = createMetricsRegistry();

    const hub = createRealtimeHub({ replayRingSize: 50 });
    const metrics = bindRealtimeMetrics(hub, registry);

    const clientA = randomUUID();
    const clientB = randomUUID();
    const instanceForeign = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();

    const connA = connectCapturingSink(hub, {
      connectionId: randomUUID(),
      userId: userA,
      clientId: clientA,
      epoch: 0,
    });
    connectCapturingSink(hub, {
      connectionId: randomUUID(),
      userId: userB,
      clientId: clientB,
      epoch: 0,
    });

    // Foreign-instance subscription refusal, through the real service.ts
    // path (fails closed - failClosedInstanceOwnership always refuses).
    const realtimeCtx: RealtimeCtx = {
      hub,
      instanceOwnership: failClosedInstanceOwnership,
      maxConnectionsPerUser: 10,
      onSubscriptionRefused: metrics.onSubscriptionRefused,
    };
    const auth: AuthenticatedContext = {
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      epoch: 0,
      role: 'owner',
    } as AuthenticatedContext;
    await subscribeConnection(
      realtimeCtx,
      { auth, requestedInstanceIds: [instanceForeign] },
      {
        write: () => {},
        comment: () => {},
        close: () => {},
        onClose: () => {},
      },
      randomUUID(),
    );

    // One publish of each of the six real-time event types (ids/enums only
    // - assertIdsOnly is what actually enforces this at publish time; this
    // test proves the OUTPUT side: nothing leaks into frames/logs/metrics).
    const instanceX = randomUUID();
    hub.publish({
      type: 'instance.qr',
      clientId: clientA,
      instanceId: instanceX,
      expiresAt: new Date().toISOString(),
      attemptsLeft: 3,
      payload: 'fake-qr-payload-for-redaction-test',
    });
    hub.publish({
      type: 'instance.health_changed',
      clientId: clientA,
      instanceId: instanceX,
      healthState: 'connected',
      pauseReason: null,
      needsUserAction: false,
    });
    hub.publish({
      type: 'instance.pacing_changed',
      clientId: clientA,
      instanceId: instanceX,
      band: 'HIGH',
      tier: 1,
      effDailyCap: 100,
      configVersion: 1,
    });
    hub.publish({
      type: 'message.job.status_changed',
      clientId: clientA,
      instanceId: instanceX,
      jobPublicId: 'job-123',
      status: 'sent',
    });
    hub.publish({
      type: 'job.needs_user_action',
      clientId: clientA,
      jobPublicId: 'job-123',
      reason: 'manual_review_required',
    });
    hub.publish({
      type: 'campaign.progress',
      clientId: clientA,
      campaignId: randomUUID(),
      sent: 1,
      queued: 0,
      failed: 0,
    });

    // A slow-consumer drop, through the real hub.disconnect path.
    hub.disconnect(hub.connectionsForUser(userA)[0]!, 'slow_consumer');
    logger.info(
      {
        event_type: 'realtime.connection_dropped',
        client_id: clientA,
        instance_id: instanceX,
      },
      'sse connection dropped: slow consumer',
    );

    // One authz tick that drops userB (membership revoked).
    const db: TenantQueryable = {
      query: (async (_sql: string, params?: unknown[]) => {
        const userIds = (params?.[0] as readonly string[] | undefined) ?? [];
        const rows: AuthzSnapshotRow[] = userIds
          .filter((id) => id !== userB)
          .map((id) => ({ userId: id, tokenEpoch: 0, clientId: clientA, clientStatus: 'active' }));
        return {
          rows: rows.map((r) => ({
            user_id: r.userId,
            token_epoch: r.tokenEpoch,
            client_id: r.clientId,
            client_status: r.clientStatus,
          })),
          rowCount: rows.length,
        };
      }) as TenantQueryable['query'],
    };
    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: metrics.incrementAuthzTickErrors },
      logger,
    });
    await tick.runOnce();

    // ---- Assertions ----

    // Every SSE frame captured on connA's sink.
    for (const frame of connA.frames) {
      assertNoLeak(frame.data);
    }

    // Every captured stdout log line (the shared `logger` singleton's real
    // destination).
    assertNoLeak(raw());
    const logLines = lines();
    for (const line of logLines) {
      assertNoLeak(JSON.stringify(line));
    }

    // The refusal log line's fields are allow-listed only (parse JSON, keys
    // subset of ALLOWED_LOG_FIELDS ∪ pino defaults).
    const refusalLine = logLines.find(
      (line) =>
        typeof line === 'object' &&
        line !== null &&
        (line as Record<string, unknown>).event_type === 'realtime.subscribe_refused',
    ) as Record<string, unknown> | undefined;
    expect(refusalLine).toBeDefined();
    const pinoDefaultKeys = new Set(['level', 'time', 'pid', 'hostname', 'msg']);
    for (const key of Object.keys(refusalLine!)) {
      const isAllowListed = ALLOWED_LOG_FIELDS.has(key as never);
      const isPinoDefault = pinoDefaultKeys.has(key);
      expect(isAllowListed || isPinoDefault).toBe(true);
    }
    expect(refusalLine!.client_id).toBe(clientA);
    expect(refusalLine!.instance_id).toBe(instanceForeign);

    // Metrics text.
    const metricsText = await registry.metricsText();
    assertNoLeak(metricsText);

    // Leak attempt: publishing an event with an extra `phone` key throws
    // and nothing is written to any sink.
    const framesBefore = connA.frames.length;
    expect(() =>
      hub.publish({
        type: 'campaign.progress',
        clientId: clientA,
        campaignId: randomUUID(),
        sent: 1,
        queued: 0,
        failed: 0,
        // @ts-expect-error - deliberately non-conforming payload under test.
        phone: '+919876543210',
      }),
    ).toThrow();
    expect(connA.frames.length).toBe(framesBefore);
  });
});
