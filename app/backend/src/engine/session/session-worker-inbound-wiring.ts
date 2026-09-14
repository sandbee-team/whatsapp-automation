import type { Redis } from 'ioredis';
import type { WAMessage } from 'baileys';
import type { TenantDb } from '@wp/db';
import { logger, describeError, type MetricsRegistry } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import {
  createInboundDispatcher,
  writeInboundDeadLetter,
  bindInboundMetrics,
  createInboundAdmission,
  bindInboundBucketCommand,
  readInboundLimitFromDb,
  handleInboundMessageSignals,
  recordInboundReceipt,
  createInflightLimiter,
  type InboundAdmission,
  type InflightLimiter,
} from '../../modules/inbound/index.js';
import { syncOptOutMirror } from '../../modules/contacts/index.js';
import { bindOptOutConfirmationSender } from '../../modules/pacing/index.js';
import { captureEchoIfFromMe } from '../../modules/queue/echo-capture.js';
import { createSendEnabledGroupJidsProvider } from '../../modules/groups/forbidden.public.js';
import { bindQueueMetrics } from '../queue/metrics.js';
import { config } from '../../platform/config.js';

/**
 * session-worker-inbound-wiring.ts (P21 Unit U6b, step 7) - the ONE place
 * that composes the headless inbound dispatcher for a real session socket:
 * `createWorkerInboundAdmission` builds the per-worker admission bucket ONCE
 * (shared across every session the worker starts), and
 * `buildInboundSocketHandlers` builds the three fire-and-forget socket
 * handlers PER SESSION (fresh echo/signals/receipt/dead-letter closures bound
 * to that session's own `clientId`/`instanceId`).
 *
 * Every handler is fire-and-forget: `createInboundDispatcher`'s own
 * `onX` methods never reject (each event is individually try/caught and
 * dead-lettered inside the dispatcher itself), but this module still
 * defends in depth with a `.catch` on the returned promise - a rejection
 * here must NEVER throw into Baileys' own event emitter (that would tear
 * down the whole socket for one bad inbound event, violating fail-safe).
 *
 * C1 fix round (reviewer MAJOR): each handler is routed through ONE
 * per-worker `InflightLimiter` (`createWorkerInboundLimiter`, built once in
 * `buildDiscoveryWiring` beside the admission bucket) so a receipt/message
 * storm on a worker holding hundreds of sessions cannot launch an unbounded
 * number of concurrent `withTenant` chains against the fixed-size pool - a
 * dropped event is counted on `wp_inbound_overflow_total`, never queued into
 * a growing in-memory backlog (ADR 0018's OOM budget).
 *
 * The echo path is UNCHANGED code (moved verbatim from
 * `session-worker-discovery-wiring.ts#buildOnMessagesUpsert`, P12 U3) - see
 * `captureEchoIfFromMe`'s own module doc for why this stays the one file
 * allowed to touch a Baileys `WAMessage` type.
 */

export interface BuildInboundSocketHandlersInput {
  env: string;
  tenantDb: TenantDb;
  redisCtl: Redis;
  keyProvider: KeyProvider;
  encVersion: number;
  clientId: string;
  instanceId: string;
  admission: InboundAdmission;
  limiter: InflightLimiter;
  metricsRegistry?: MetricsRegistry;
}

export interface InboundSocketHandlers {
  onMessagesUpsert: (payload: unknown) => void;
  onMessagesUpdate: (payload: unknown) => void;
  onMessageReceiptUpdate: (payload: unknown) => void;
}

/** ONE per worker - the admission bucket is shared across every session this worker runs (the Redis key itself is still per-instance, see admission.ts). */
export function createWorkerInboundAdmission(input: {
  env: string;
  tenantDb: TenantDb;
  redisCtl: Redis;
}): InboundAdmission {
  return createInboundAdmission({
    env: input.env,
    bucket: bindInboundBucketCommand(input.redisCtl),
    readLimit: readInboundLimitFromDb(input.tenantDb),
    defaults: {
      maxPerMinute: config.INBOUND_MAX_PER_MINUTE,
      burst: config.INBOUND_BURST,
    },
  });
}

/** ONE per worker (never per session) - see this module's own doc comment for why an unbounded fire-and-forget burst is the exact OOM shape being guarded against here. */
export function createWorkerInboundLimiter(input: {
  metricsRegistry?: MetricsRegistry;
}): InflightLimiter {
  return createInflightLimiter({
    maxInFlight: config.INBOUND_MAX_INFLIGHT,
    maxPending: config.INBOUND_MAX_PENDING,
    metrics: bindInboundMetrics(input.metricsRegistry),
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
  });
}

/** P12 U3 (moved verbatim, step 7) - the `fromMe` echo-capture closure. One try/catch PER MESSAGE (phase requirement: "a throw skips one echo, never the socket"). */
function buildEcho(
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
): (message: unknown) => Promise<void> {
  const queueMetrics = bindQueueMetrics();
  return async (message: unknown): Promise<void> => {
    try {
      await captureEchoIfFromMe(message as WAMessage, {
        tenantDb,
        clientId,
        instanceId,
        logger: { warn: (msg) => logger.warn({}, msg) },
        metrics: {
          incrementEchoCaptureFailed: () => queueMetrics.echoCaptureFailedTotal.inc(),
        },
      });
    } catch (err) {
      queueMetrics.echoCaptureFailedTotal.inc();
      logger.warn({}, `echo-capture: synchronous throw before await: ${describeError(err)}`);
    }
  };
}

/** Builds the three fire-and-forget socket handlers for ONE session. */
export function buildInboundSocketHandlers(
  input: BuildInboundSocketHandlersInput,
): InboundSocketHandlers {
  // `input.env` is deliberately unread here: it is consumed once, by
  // `createWorkerInboundAdmission` (built ONE per worker, before this
  // per-session composition runs) - `admission` arrives already built.
  const { tenantDb, keyProvider, encVersion, clientId, instanceId, admission, limiter } = input;
  const metrics = bindInboundMetrics(input.metricsRegistry);

  const deadLetter = (dl: Parameters<typeof writeInboundDeadLetter>[1]) =>
    writeInboundDeadLetter(
      {
        tenantDb,
        clientId,
        instanceId,
        metrics,
        logger: { warn: (obj, msg) => logger.warn(obj, msg) },
      },
      dl,
    );

  const echo = buildEcho(tenantDb, clientId, instanceId);

  const receipt = (r: Parameters<typeof recordInboundReceipt>[1]) =>
    recordInboundReceipt({ tenantDb, clientId, instanceId, metrics }, r);

  const onOptedOut = bindOptOutConfirmationSender(
    { tenantDb },
    { error: (msg, meta) => logger.error(meta ?? {}, msg) },
  );

  const signals = (s: Parameters<typeof handleInboundMessageSignals>[1]) =>
    handleInboundMessageSignals(
      {
        tenantDb,
        clientId,
        instanceId,
        keyProvider,
        encVersion,
        metrics,
        metricsRegistry: input.metricsRegistry,
        mirror: syncOptOutMirror,
        onOptedOut: async (payload) => {
          onOptedOut(payload);
        },
      },
      s,
    );

  // P24 Unit U4b - the real send-enabled-group allow-list, background-
  // refreshed (see send-enabled-jids.ts's own header for the fail-open
  // direction). `get` is synchronous, matching `sendEnabledGroupJids`'s own
  // contract; `refresh()` is kicked off once here, fire-and-forget, so the
  // FIRST message of a session is not forced through an empty set for a
  // full `ttlMs` window. The provider holds no internal timer (refreshes are
  // demand-driven from `get()`), so there is no teardown call needed here.
  const sendEnabledGroupJids = createSendEnabledGroupJidsProvider({
    tenantDb,
    clientId,
    instanceId,
    clock: { now: () => Date.now() },
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
  });
  // `refresh()` never rejects (its own try/catch keeps the previous snapshot
  // and logs) - fire-and-forget with no `.catch` needed, unlike the socket
  // handlers below which wrap a port with no such guarantee.
  void sendEnabledGroupJids.refresh();

  const dispatcher = createInboundDispatcher({
    clientId,
    instanceId,
    admission,
    sendEnabledGroupJids: sendEnabledGroupJids.get,
    echo,
    signals,
    receipt,
    deadLetter,
    metrics,
    logger: { warn: (obj, msg) => logger.warn(obj, msg) },
  });

  // Trade-off (C1 re-review, 2026-09-05): ONE FIFO per worker, shared by
  // message and receipt events. The admission bucket sheds a message INSIDE
  // its task - after a slot was taken - so a message flood can queue receipts
  // behind up to `maxPending` message tasks or drop them (counted on
  // `wp_inbound_overflow_total{kind="receipt"}`). A dropped receipt is a lost
  // `delivery_events` row, never lost queued work. Follow-up if that counter
  // is ever non-zero in production: split queues or a receipt reservation.
  function fireAndForget(
    run: () => Promise<void>,
    eventName: 'messages.upsert' | 'messages.update' | 'message-receipt.update',
    kind: 'message' | 'receipt',
  ): void {
    limiter.run(kind, () =>
      run().catch((err: unknown) => {
        logger.warn(
          {
            client_id: clientId,
            instance_id: instanceId,
            error_class: err instanceof Error ? err.name : 'unknown',
          },
          `inbound: dispatcher rejected for ${eventName} (should be unreachable)`,
        );
      }),
    );
  }

  return {
    onMessagesUpsert: (payload) =>
      fireAndForget(() => dispatcher.onMessagesUpsert(payload), 'messages.upsert', 'message'),
    onMessagesUpdate: (payload) =>
      fireAndForget(() => dispatcher.onMessagesUpdate(payload), 'messages.update', 'receipt'),
    onMessageReceiptUpdate: (payload) =>
      fireAndForget(
        () => dispatcher.onMessageReceiptUpdate(payload),
        'message-receipt.update',
        'receipt',
      ),
  };
}
