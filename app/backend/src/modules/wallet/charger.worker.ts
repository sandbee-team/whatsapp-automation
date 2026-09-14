import { tenantKey, sysKey } from '../../platform/redis.js';
import { chargeRepairedSend } from './charge.js';
import { TIMING } from '@wp/domain';
import type { TenantDb } from '@wp/db';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';

/**
 * charger.worker.ts (P18 Unit U5) - the per-tenant Redis work-item queue that
 * charges a repaired send (`wallet-sink.ts`'s `onRepairedSent`) OFF the
 * critical path of the reaper sweep itself. `enqueue` is BEST-EFFORT and
 * NEVER throws - correctness for the repaired-charge path rests on
 * `charge.ts`'s guard-first debit (idempotent, keyed on `send_attempts.id`)
 * plus the hourly reconciler's check B (`reconcile.ts`), never on this queue
 * actually delivering a given item. A dropped/expired work item is simply a
 * slower charge (via check B), never a lost or duplicate one.
 *
 * Keys: a per-tenant bounded list (`tenantKey(env, clientId, 'charge')`,
 * holding attempt ids) plus a system-wide index set of client ids with
 * pending work (`sysKey(env, 'sys', 'wallet', 'charge-pending')`) so
 * `drainOnce` never has to scan for which tenants have work. The list is
 * BOUNDED via `LTRIM` on every push - correctness never depends on the list
 * holding every enqueued item (see check B above); this only bounds memory
 * under a broken/backed-up drain.
 *
 * TIMEOUT (C2 hardening, F2 item 3): the shared Redis client
 * (`platform/redis.ts`) deliberately carries no global `commandTimeout` (its
 * `connectTimeout`/`maxRetriesPerRequest` only bound the CONNECT leg), so a
 * connected-but-hung command would otherwise stall the reaper's per-row hook
 * indefinitely. Every `enqueue`/`drainOnce` Redis call sequence is raced
 * locally against `TIMING.redisCommandTimeoutMs` - on timeout the work item
 * is treated as DROPPED (best-effort; check B is the backstop), never
 * thrown; `drainOnce` likewise ends the tick early and reports `failed` for
 * whatever it could not finish popping.
 */

export interface ChargeWorkItem {
  clientId: string;
  attemptId: string;
}

/** Structural subset of ioredis's command surface this worker needs - never the concrete `Redis` type, so a test double satisfies this without a real connection. */
export interface ChargerRedis {
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  spop(key: string, count: number): Promise<string[]>;
  rpop(key: string, count: number): Promise<string[] | null>;
}

export interface ChargerWorkerDeps {
  redis: ChargerRedis;
  env: string;
  tenantDb: TenantDb;
  metrics?: Pick<WalletMetricsHandles, 'incDebit'>;
  logger?: { warn(meta: object, msg: string): void };
  /** Bounded per-tenant list length - defaults 1000. */
  maxQueueLength?: number;
  /** Bounded number of clients drained per `drainOnce()` call - defaults 50. */
  maxClientsPerDrain?: number;
  /** Bounded number of items popped per client per `drainOnce()` call - defaults 200. */
  maxItemsPerClient?: number;
  /** Hard per-Redis-command-sequence timeout in ms. Defaults to `TIMING.redisCommandTimeoutMs`. */
  redisCommandTimeoutMs?: number;
  /** Injectable for tests - defaults to the real `setTimeout`/`clearTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

class ChargerRedisTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`charger.worker: '${command}' timed out after ${String(timeoutMs)}ms`);
    this.name = 'ChargerRedisTimeoutError';
  }
}

/**
 * Races `run()` against a hard timeout, same shape as `lease-redis.ts`'s own
 * `withTimeout` - the timer always clears (success, failure, or timeout) so
 * no dangling timer keeps the process alive; the underlying `run()`
 * promise's eventual settlement (if any) is ignored once this has settled.
 */
function withTimeout<T>(
  run: () => Promise<T>,
  command: string,
  timeoutMs: number,
  setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new ChargerRedisTimeoutError(command, timeoutMs));
    }, timeoutMs);

    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(err as Error);
      },
    );
  });
}

export interface DrainOnceResult {
  clients: number;
  charged: number;
  noop: number;
  failed: number;
}

export interface ChargerWorker {
  /** Never throws - a broken Redis logs a warn (client_id + attempt id only) and resolves. */
  enqueue(item: ChargeWorkItem): Promise<void>;
  drainOnce(): Promise<DrainOnceResult>;
}

const NOOP_LOGGER = { warn: (): void => undefined };

export function createChargerWorker(deps: ChargerWorkerDeps): ChargerWorker {
  const maxQueueLength = deps.maxQueueLength ?? 1000;
  const maxClientsPerDrain = deps.maxClientsPerDrain ?? 50;
  const maxItemsPerClient = deps.maxItemsPerClient ?? 200;
  const logger = deps.logger ?? NOOP_LOGGER;
  const pendingIndexKey = sysKey(deps.env, 'sys', 'wallet', 'charge-pending');
  const commandTimeoutMs = deps.redisCommandTimeoutMs ?? TIMING.redisCommandTimeoutMs;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const bounded = <T>(run: () => Promise<T>, command: string): Promise<T> =>
    withTimeout(run, command, commandTimeoutMs, setTimeoutFn, clearTimeoutFn);

  return {
    async enqueue(item: ChargeWorkItem): Promise<void> {
      const listKey = tenantKey(deps.env, item.clientId, 'charge');
      try {
        // Index FIRST, then push: if the 2s budget expires mid-sequence, the
        // worst case is a client indexed with an empty list (one wasted RPOP),
        // never an item pushed but invisible to drainOnce (re-review WARNING 1).
        await bounded(async () => {
          await deps.redis.sadd(pendingIndexKey, item.clientId);
          await deps.redis.lpush(listKey, item.attemptId);
          await deps.redis.ltrim(listKey, 0, maxQueueLength - 1);
        }, 'enqueue');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { client_id: item.clientId, send_attempt_id: item.attemptId },
          `charger.worker: enqueue failed, best-effort only: ${message}`,
        );
      }
    },

    async drainOnce(): Promise<DrainOnceResult> {
      const result: DrainOnceResult = { clients: 0, charged: 0, noop: 0, failed: 0 };

      let clientIds: string[];
      try {
        clientIds = await bounded(
          () => deps.redis.spop(pendingIndexKey, maxClientsPerDrain),
          'spop',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({}, `charger.worker: drainOnce spop timed out, ending tick early: ${message}`);
        return result;
      }

      for (const clientId of clientIds) {
        result.clients += 1;
        const listKey = tenantKey(deps.env, clientId, 'charge');
        let attemptIds: string[];
        try {
          attemptIds =
            (await bounded(() => deps.redis.rpop(listKey, maxItemsPerClient), 'rpop')) ?? [];
        } catch (err) {
          result.failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { client_id: clientId },
            `charger.worker: drainOnce rpop timed out for this client: ${message}`,
          );
          continue;
        }

        for (const attemptId of attemptIds) {
          try {
            const charged = await chargeRepairedSend(
              deps.tenantDb,
              { clientId, attemptId },
              { metrics: deps.metrics },
            );
            if (charged.seq !== null) {
              result.charged += 1;
            } else {
              result.noop += 1;
            }
          } catch (err) {
            result.failed += 1;
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(
              { client_id: clientId, send_attempt_id: attemptId },
              `charger.worker: charge failed, not re-enqueued (reconciler check B is the backstop): ${message}`,
            );
          }
        }

        if (attemptIds.length === maxItemsPerClient) {
          try {
            await bounded(() => deps.redis.sadd(pendingIndexKey, clientId), 'sadd-reindex');
          } catch {
            // Best-effort re-index: the next enqueue for this client re-adds it;
            // reconciler check B is the backstop either way.
          }
        }
      }

      return result;
    },
  };
}
