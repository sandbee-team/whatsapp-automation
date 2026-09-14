import type { TenantQueryable } from '@wp/db';
import { emit } from '../../modules/events/index.js';
import type { PacingEvaluatorPublish } from '../pacing/warmup-evaluator.js';
import type { SingleFlightPool } from './single-flight.js';

/**
 * cron-wiring-pacing-publish.ts (split out of `cron-wiring.ts` at the
 * max-lines cap, same idiom as `cron-wiring-wallet.ts`/
 * `cron-wiring-contacts.ts`) - `buildOutboxPacingPublish`, the pacing
 * evaluator's real default publisher.
 *
 * `roles/cron.ts` never imports `engine/session/**`/`provider/**`
 * (structurally asserted), so `instance.pacing_changed` goes through the
 * outbox (`emit(tx, ...)`) instead of a direct cross-process publish call
 * (ADR 0010) - the relay role (already reading the outbox) actually
 * publishes it. A caller may inject a fake for tests, same "real default,
 * injectable" shape as every other optional dep in `cron-wiring.ts`.
 */

/** The minimal pool port this module needs: both sweeps' bounded cross-tenant `query()` plus `single-flight.ts`'s own `connect()`. A real `pg.Pool` satisfies this structurally - never imported here by name. */
export type CronWiringPool = SingleFlightPool & {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function buildOutboxPacingPublish(pool: CronWiringPool): PacingEvaluatorPublish {
  return async (event) => {
    await emit(pool as unknown as TenantQueryable, {
      clientId: event.clientId,
      instanceId: event.instanceId,
      type: 'instance.pacing_changed',
      entityId: event.instanceId,
      payload: {
        instanceId: event.instanceId,
        band: event.band,
        tier: event.tier,
        effDailyCap: event.effDailyCap,
        configVersion: event.configVersion,
      },
      fanout: ['sse'],
    });
  };
}
