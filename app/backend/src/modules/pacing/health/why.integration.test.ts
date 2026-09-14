import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { HEALTH_SIGNAL_NAMES, INSTANCE_CARD_COPY } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { readHealthWhy } from './why.service.js';

/**
 * why.integration.test.ts (P17 Unit U4, step 8) - `readHealthWhy` against
 * real Postgres: all twelve signals are returned in registry order, the
 * three scored signals carry a real `pointsCost`, every other signal reports
 * `scored: false` with `pointsCost: 0` and the honesty copy key, and a
 * signal with zero evidence is reported as not-enough-data, never a penalty.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'why-test' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const SCORED_KEYS = new Set(['hard_restriction', 'rejected_send_rate', 'delivery_ratio']);

describe('readHealthWhy (P17 Unit U4, real Postgres)', () => {
  it('all_twelve_signals_are_returned_and_unscored_ones_say_so', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);

    const evidence: Record<string, unknown> = {};
    for (const name of HEALTH_SIGNAL_NAMES) {
      evidence[name] = SCORED_KEYS.has(name)
        ? {
            numerator: 3,
            denominator: 40,
            value: 0.075,
            severity: 0.1,
            weightApplied: 10,
            unmeasured: false,
          }
        : {
            // Evidence-only in v1: measured (unmeasured: false), just never
            // weighted into the score - score.ts's own "weightApplied: 0 for
            // every non-scored signal" contract.
            numerator: 3,
            denominator: 40,
            value: 0.075,
            severity: 0.1,
            weightApplied: 0,
            unmeasured: false,
          };
    }
    await pool.query(
      `UPDATE instance_pacing_state SET last_evidence = $1 WHERE instance_id = $2 AND client_id = $3`,
      [JSON.stringify(evidence), instanceId, clientId],
    );

    const result = await readHealthWhy(tenantDb, { clientId, instanceId, timelineLimit: 20 });

    expect(result.signals).toHaveLength(HEALTH_SIGNAL_NAMES.length);
    expect(result.signals.map((s) => s.signal)).toEqual([...HEALTH_SIGNAL_NAMES]);

    for (const entry of result.signals) {
      if (SCORED_KEYS.has(entry.signal)) {
        expect(entry.scored).toBe(true);
        expect(entry.pointsCost).toBeGreaterThan(0);
        expect(entry.exemptReason).toBeNull();
      } else {
        expect(entry.scored).toBe(false);
        expect(entry.pointsCost).toBe(0);
        expect(entry.exemptReason).toBe(INSTANCE_CARD_COPY.signalNotScored);
      }
    }
  });

  it('an_unmeasured_signal_is_not_reported_as_unhealthy', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    // instance_pacing_state.last_evidence defaults to '{}' (no evidence at
    // all yet) - every signal must resolve to the not-enough-data shape.
    const result = await readHealthWhy(tenantDb, { clientId, instanceId, timelineLimit: 20 });

    expect(result.signals).toHaveLength(HEALTH_SIGNAL_NAMES.length);
    for (const entry of result.signals) {
      expect(entry.measuredValue).toBeNull();
      expect(entry.evidenceCount).toBe(0);
      expect(entry.pointsCost).toBe(0);
      if (!SCORED_KEYS.has(entry.signal)) {
        expect(entry.exemptReason).toBe(INSTANCE_CARD_COPY.signalNotEnoughData);
      }
    }
  });

  it('the_timeline_returns_the_last_n_pacing_events_for_the_instance', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO pacing_events (id, client_id, instance_id, kind, from_value, to_value, reason_codes)
         VALUES ($1, $2, $3, 'BAND_CHANGE', '{}', '{}', ARRAY['test'])`,
        [randomUUID(), clientId, instanceId],
      );
    }

    const result = await readHealthWhy(tenantDb, { clientId, instanceId, timelineLimit: 2 });
    expect(result.timeline).toHaveLength(2);
    for (const entry of result.timeline) {
      expect(entry.kind).toBe('BAND_CHANGE');
    }
  });
});
