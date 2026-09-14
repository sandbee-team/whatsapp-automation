import { loadQuery, bindQueryParams, type TenantDb } from '@wp/db';
import { normalizeJidUser, type Clock } from '@wp/domain';

/**
 * send-enabled-jids.ts (P24 Unit U4b, step 8) - the session worker's own
 * background-refreshing group allow-list: `sendEnabledGroupJids` is
 * `InboundDispatcherDeps`'s SYNCHRONOUS dependency, so it can never itself
 * await a query - `get()` returns whatever snapshot is currently held and,
 * only when that snapshot is older than `ttlMs`, schedules ONE background
 * `refresh()` (never a concurrent second one - `refreshInFlight` below is the
 * guard).
 *
 * FAIL-OPEN DIRECTION (deliberate, matches the filter's own contract in
 * `@wp/domain`'s `ignore-jid.ts`): a failing refresh logs (ids only) and
 * KEEPS the previous snapshot rather than clearing it or throwing - a stale
 * allow-list under-admits (drops a newly-enabled group's messages for up to
 * one refresh cycle), never over-admits (a revoked group never regains
 * eligibility just because a refresh happened to fail). Dropping a group
 * MESSAGE is the safe direction; a receipt never consults this set at all
 * (`ignore-jid.ts`'s own receipt-scope short-circuit).
 *
 * Stores NORMALISED jids only (`normalizeJidUser`) - the same canonical form
 * `shouldIgnoreJid`'s group branch compares against - and never a subject,
 * participant, or any other group-shaped identity (this table is counts/
 * jids only, migration 0066's own header).
 */

interface SendEnabledGroupJidsLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CreateSendEnabledGroupJidsProviderOptions {
  tenantDb: TenantDb;
  clientId: string;
  instanceId: string;
  clock: Clock;
  /** Snapshot staleness bound; a `get()` past this age schedules one background refresh. Defaults to 30s. */
  ttlMs?: number;
  logger?: SendEnabledGroupJidsLogger;
}

export interface SendEnabledGroupJidsProvider {
  /** Synchronous - returns the last snapshot, scheduling a background refresh when it is stale. */
  get(): ReadonlySet<string>;
  refresh(): Promise<void>;
  /** No timer is held by this provider (refreshes are demand-driven from `get()`/callers) - kept for the teardown-hook symmetry every other per-session port in this tree exposes. */
  stop(): void;
}

interface GroupJidRow extends Record<string, unknown> {
  group_jid: string;
}

const DEFAULT_TTL_MS = 30_000;

export function createSendEnabledGroupJidsProvider(
  options: CreateSendEnabledGroupJidsProviderOptions,
): SendEnabledGroupJidsProvider {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let snapshot: ReadonlySet<string> = new Set();
  let lastRefreshedAt = -Infinity;
  let refreshInFlight: Promise<void> | null = null;
  let stopped = false;

  async function runRefresh(): Promise<void> {
    try {
      const query = await loadQuery('groups-send-enabled-jids');
      const params = bindQueryParams(query, {
        client_id: options.clientId,
        instance_id: options.instanceId,
      });
      const rows = await options.tenantDb.withTenant(options.clientId, (tx) =>
        tx.query<GroupJidRow>(query.text, params),
      );
      snapshot = new Set(rows.rows.map((row) => normalizeJidUser(row.group_jid)));
      lastRefreshedAt = options.clock.now();
    } catch (err) {
      options.logger?.warn(
        {
          client_id: options.clientId,
          instance_id: options.instanceId,
          error_class: err instanceof Error ? err.name : 'unknown',
        },
        'send-enabled-jids: refresh failed, keeping previous snapshot',
      );
    }
  }

  function refresh(): Promise<void> {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    const inFlight = runRefresh().finally(() => {
      refreshInFlight = null;
    });
    refreshInFlight = inFlight;
    return inFlight;
  }

  function get(): ReadonlySet<string> {
    if (!stopped && options.clock.now() - lastRefreshedAt > ttlMs) {
      void refresh();
    }
    return snapshot;
  }

  return {
    get,
    refresh,
    stop: () => {
      stopped = true;
    },
  };
}
