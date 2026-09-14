import { randomUUID } from 'node:crypto';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { open } from '@wp/server-kit/crypto';
import type { TenantQueryable } from '@wp/db';
import {
  safeFetch,
  SafeFetchError,
  type SafeFetchOptions,
} from '../../platform/http/safe-fetch.js';
import { emit } from '../events/index.js';
import { projectAllowedPayload } from './dispatcher-payload-projection.js';
import { provisioningRepo } from '../tenancy/index.js';
import { signWebhookBody, buildSignatureHeader } from './sign.js';
import { computeNextAttemptDelayMs, isTerminalStatusCode, MAX_ATTEMPTS } from './backoff.js';
import { bytesToSealedBlob } from './secret-codec.js';
import {
  claimDueDeliveries,
  markDeliverySent,
  markDeliveryFailed,
  scheduleDeliveryRetry,
  recordEndpointSuccess,
  incrementEndpointFailures,
  disableEndpointForConsecutiveFailures,
  type ClaimedDeliveryRow,
} from './repo.js';
import type { RelayPool, RelayPoolClient } from '../events/index.js';

/**
 * dispatcher.ts (P15 U5, step 7) - the webhook dispatcher's own tick, the
 * relay's SECOND loop (`roles/relay.ts` pushes `createDispatcherLoop`'s
 * `{start, stop}` onto `secondaryLoops`). Durable-first (core invariant 1):
 * `repo.claimDueDeliveries` reads a row the RELAY LOOP already wrote as
 * `pending` BEFORE any HTTP call ever happens - this module never creates a
 * delivery row itself, only claims/updates one. `SET LOCAL ROLE wp_relay`
 * on ONE pinned connection per tick (same `withRelayRole` shape
 * `relay-loop.ts` uses, duplicated here rather than imported to avoid this
 * module depending on that file's internals - the shape is the contract,
 * not a shared function).
 *
 * DISABLE-AT-20 (phase step 7, verbatim): a TERMINAL outcome (non-retryable
 * status class OR MAX_ATTEMPTS exhausted) increments
 * `webhook_endpoints.consecutive_failures`; at 20 the endpoint is disabled
 * (`enabled=false`, `disabled_reason='consecutive_failures'`) with an
 * `audit_logs` row and a `webhook.endpoint_disabled` outbox event (`fanout:
 * ['sse']` - the panel should hear about it live; NOT `webhook` fanout, an
 * endpoint that just got disabled cannot receive its own disablement
 * notice). A SUCCESS resets the counter to 0 (`repo.recordEndpointSuccess`).
 *
 * PER-CLIENT IN-FLIGHT CAP (invariant 4, tenant isolation): at most 4
 * concurrent in-flight dispatches per `client_id` within one tick, so one
 * slow endpoint's `totalTimeoutMs` cannot starve every other tenant's
 * deliveries for the whole tick - see `runDispatchTick`'s own scheduling.
 */

const DISABLE_THRESHOLD = 20;
const PER_CLIENT_IN_FLIGHT_CAP = 4;

export interface DispatcherDeps {
  pool: RelayPool;
  keyProvider: KeyProvider;
  clock: { now: () => Date };
  rng: () => number;
  /** Injectable so tests never dial a real network - production wiring is `safeFetch` itself. */
  fetch: (url: string, options: SafeFetchOptions) => ReturnType<typeof safeFetch>;
  limit?: number;
}

export const DEFAULT_DISPATCH_CLAIM_LIMIT = 200;

async function withRelayRole<T>(
  pool: RelayPool,
  fn: (client: RelayPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_relay');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
        releaseError = undefined;
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    }
  } finally {
    if (releaseError !== undefined) {
      client.release(releaseError as Error);
    } else {
      client.release();
    }
  }
}

function unsealSecret(
  provider: KeyProvider,
  clientId: string,
  endpointId: string,
  secretEnc: Buffer,
): string {
  const blob = bytesToSealedBlob(secretEnc);
  const plaintext = open(blob, {
    provider,
    purpose: 'tenant-secrets',
    tableName: 'webhook_endpoints',
    columnName: 'secret_enc',
    clientId,
    recordId: endpointId,
  });
  return plaintext.toString('utf8');
}

/** Emits the disable event + audit row on the SAME transaction the failure-count UPDATE ran on - one durable unit, never a partial disable. */
async function disableEndpoint(client: RelayPoolClient, row: ClaimedDeliveryRow): Promise<void> {
  await disableEndpointForConsecutiveFailures(client, row.endpointId);
  await provisioningRepo.insertAuditLog(client as unknown as TenantQueryable, {
    clientId: row.clientId,
    actorType: 'system',
    action: 'webhook.endpoint_disabled',
    targetType: 'webhook_endpoint',
    targetId: row.endpointId,
    metadata: { reason: 'consecutive_failures' },
  });
  await emit(client as unknown as TenantQueryable, {
    clientId: row.clientId,
    type: 'webhook.endpoint_disabled',
    entityId: row.endpointId,
    payload: { endpointId: row.endpointId },
    fanout: ['sse'],
    coalesceKey: `webhooks:${row.endpointId}`,
  });
}

async function applyTerminalOutcome(
  client: RelayPoolClient,
  row: ClaimedDeliveryRow,
  outcome: { statusCode: number | null; errorClass: string },
): Promise<void> {
  await markDeliveryFailed(client, row.id, outcome);
  const health = await incrementEndpointFailures(client, row.endpointId);
  if (health.enabled && health.consecutiveFailures >= DISABLE_THRESHOLD) {
    await disableEndpoint(client, row);
  }
}

async function dispatchOne(deps: DispatcherDeps, row: ClaimedDeliveryRow): Promise<void> {
  const secret = unsealSecret(deps.keyProvider, row.clientId, row.endpointId, row.secretEnc);
  const now = deps.clock.now();
  const timestamp = Math.floor(now.getTime() / 1000);
  const allowedPayload = projectAllowedPayload(row.eventType, row.eventPayload);
  const body = JSON.stringify({ id: row.outboxEventId, type: row.eventType, ...allowedPayload });
  const signature = signWebhookBody(secret, timestamp, body);

  let statusCode: number | null = null;
  let networkErrorClass: string | null = null;

  try {
    const response = await deps.fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Signature': buildSignatureHeader(timestamp, signature),
        'X-WP-Event-Id': row.outboxEventId,
        'X-WP-Timestamp': String(timestamp),
      },
      body,
    });
    statusCode = response.statusCode;
  } catch (err) {
    networkErrorClass = err instanceof SafeFetchError ? err.code : 'network_error';
  }

  await withRelayRole(deps.pool, async (client) => {
    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      await markDeliverySent(client, row.id, statusCode);
      await recordEndpointSuccess(client, row.endpointId);
      return;
    }

    const terminal = statusCode !== null && isTerminalStatusCode(statusCode);
    const attemptsExhausted = row.attempt + 1 >= MAX_ATTEMPTS;
    const errorClass =
      statusCode !== null ? `http_${String(statusCode)}` : (networkErrorClass ?? 'unknown');

    if (terminal || attemptsExhausted) {
      await applyTerminalOutcome(client, row, { statusCode, errorClass });
      return;
    }

    const delayMs = computeNextAttemptDelayMs(row.attempt, deps.rng);
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    await scheduleDeliveryRetry(client, row.id, { statusCode, errorClass, nextAttemptAt });
  });
}

/**
 * Runs one dispatch tick: claims up to `limit` due deliveries (single
 * `wp_relay` transaction), then dispatches them grouped by `client_id` with
 * at most `PER_CLIENT_IN_FLIGHT_CAP` concurrent in-flight requests PER
 * CLIENT (never a global concurrency cap alone - that would still let one
 * tenant's slow endpoint occupy the whole budget). Returns the number of
 * deliveries claimed this tick.
 */
export async function runDispatchTick(deps: DispatcherDeps): Promise<number> {
  const limit = deps.limit ?? DEFAULT_DISPATCH_CLAIM_LIMIT;

  const claimed = await withRelayRole(deps.pool, (client) => claimDueDeliveries(client, limit));
  if (claimed.length === 0) {
    return 0;
  }

  const byClient = new Map<string, ClaimedDeliveryRow[]>();
  for (const row of claimed) {
    const list = byClient.get(row.clientId) ?? [];
    list.push(row);
    byClient.set(row.clientId, list);
  }

  async function runClientQueue(rows: ClaimedDeliveryRow[]): Promise<void> {
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < rows.length) {
        const row = rows[cursor];
        cursor += 1;
        if (row) await dispatchOne(deps, row);
      }
    }
    const workers = Array.from({ length: Math.min(PER_CLIENT_IN_FLIGHT_CAP, rows.length) }, () =>
      worker(),
    );
    await Promise.all(workers);
  }

  await Promise.all(Array.from(byClient.values()).map((rows) => runClientQueue(rows)));

  return claimed.length;
}

export interface DispatcherLoop {
  start(): void;
  stop(): void;
}

/** `roles/relay.ts`'s secondary-loop wiring shape - a plain `setInterval` over `runDispatchTick`, same idiom as the drain/cleanup loops. */
export function createDispatcherLoop(
  deps: DispatcherDeps,
  tickMs: number,
  onError: (err: unknown) => void,
): DispatcherLoop {
  let handle: ReturnType<typeof setInterval> | undefined;
  return {
    start(): void {
      handle = setInterval(() => {
        void runDispatchTick(deps).catch(onError);
      }, tickMs);
    },
    stop(): void {
      if (handle !== undefined) clearInterval(handle);
    },
  };
}

// randomUUID retained for callers that need a fresh id shape elsewhere in
// this module's test-support fixtures (re-exported for convenience, avoids
// a second `node:crypto` import at call sites).
export { randomUUID };
