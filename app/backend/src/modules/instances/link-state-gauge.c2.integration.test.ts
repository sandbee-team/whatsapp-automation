import { createPool } from '@wp/db';
import { metrics as defaultMetrics } from '@wp/server-kit';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { applyTransitionWrite, markLinkedConnected, markLoggedOut } from './repo.js';
import {
  PROBE_WORKER_ID,
  cleanupProbeClients,
  ctxFor,
  seedLease,
  seedTenant,
  type TestPool,
} from './__tests__/instances-test-helpers.js';

/**
 * link-state-gauge.c2.integration.test.ts (P25 SESSION-PROTOCOL C2
 * edge-case pass) - `repo.ts`'s real ENGINE write points
 * (markLinkedConnected/markLoggedOut/applyTransitionWrite) call
 * `setInstanceLinkStateGauge` against the SHARED `@wp/server-kit` `metrics`
 * singleton (no registry override reaches these call sites) - proves (a) a
 * pairing -> linked -> unlinked sequence for ONE instance leaves exactly one
 * series carrying the LAST value (a gauge `.set()`, never an additional
 * series), (b) `applyTransitionWrite` with `linkState: null` never touches
 * the gauge, and (c) two tenants' instances produce two independent series
 * and nothing else on the shared registry carries their ids.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function gaugeLineFor(instanceId: string): Promise<string | undefined> {
  const text = await defaultMetrics.metricsText();
  return text
    .split('\n')
    .find(
      (line) =>
        line.startsWith('wp_instance_link_state') && line.includes(`instance_id="${instanceId}"`),
    );
}

describe('one_instance_transitioning_pairing_linked_unlinked_leaves_exactly_one_series_at_the_last_value', () => {
  it('markLinkedConnected then markLoggedOut leaves ONE series at the unlinked (0) value, never two', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const fence = 21n;
    await seedLease(pool, { clientId, instanceId, fence });
    const ctx = ctxFor(pool, clientId);

    await markLinkedConnected(ctx, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'c2-probe-owner@s.whatsapp.net',
      phoneE164: '+15551230000',
    });
    const linkedLine = await gaugeLineFor(instanceId);
    expect(linkedLine).toBeDefined();
    expect(linkedLine).toContain(' 2'); // 'linked' encodes to 2

    await markLoggedOut(ctx, { instanceId, fence, workerId: PROBE_WORKER_ID });
    const unlinkedLine = await gaugeLineFor(instanceId);
    expect(unlinkedLine).toBeDefined();
    expect(unlinkedLine).toContain(' 0'); // 'unlinked' encodes to 0

    // Exactly one line for this instance in the whole scrape - a .set() on
    // the SAME label set, never a second series appended.
    const text = await defaultMetrics.metricsText();
    const allLinesForInstance = text
      .split('\n')
      .filter((line) => line.includes(`instance_id="${instanceId}"`));
    expect(allLinesForInstance).toHaveLength(1);
  });
});

describe('applyTransitionWrite_with_a_null_linkState_never_touches_the_gauge', () => {
  it('a null linkState transition leaves NO gauge series for an instance that was never linked/logged-out', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const fence = 22n;
    await seedLease(pool, { clientId, instanceId, fence });
    const ctx = ctxFor(pool, clientId);

    // No prior markLinkedConnected/markLoggedOut call for this instance -
    // the gauge has never been set for it.
    await applyTransitionWrite(ctx, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
      healthState: 'degraded',
      linkState: null,
      needsUserAction: false,
      userActionReason: null,
      pauseReason: null,
      disconnectionReasonCode: null,
      disconnectionReasonLabel: null,
    });

    const line = await gaugeLineFor(instanceId);
    expect(line).toBeUndefined();
  });

  it('a non-null linkState transition DOES set the gauge to the encoded value', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const fence = 23n;
    await seedLease(pool, { clientId, instanceId, fence });
    const ctx = ctxFor(pool, clientId);

    await applyTransitionWrite(ctx, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
      healthState: 'connected',
      linkState: 'pairing',
      needsUserAction: false,
      userActionReason: null,
      pauseReason: null,
      disconnectionReasonCode: null,
      disconnectionReasonLabel: null,
    });

    const line = await gaugeLineFor(instanceId);
    expect(line).toBeDefined();
    expect(line).toContain(' 1'); // 'pairing' encodes to 1
  });
});

describe('two_tenants_instances_produce_two_independent_series', () => {
  it('each instance gets its own series carrying only its own id, nothing bleeds across tenants', async () => {
    const tenantA = await seedTenant(pool, { healthState: 'connected' });
    const tenantB = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(tenantA.clientId, tenantB.clientId);
    const fenceA = 24n;
    const fenceB = 25n;
    await seedLease(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      fence: fenceA,
    });
    await seedLease(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      fence: fenceB,
    });

    await markLinkedConnected(ctxFor(pool, tenantA.clientId), {
      instanceId: tenantA.instanceId,
      fence: fenceA,
      workerId: PROBE_WORKER_ID,
      ownerJid: `${randomUUID()}@s.whatsapp.net`,
      phoneE164: '+15551230001',
    });
    await markLoggedOut(ctxFor(pool, tenantB.clientId), {
      instanceId: tenantB.instanceId,
      fence: fenceB,
      workerId: PROBE_WORKER_ID,
    });

    const lineA = await gaugeLineFor(tenantA.instanceId);
    const lineB = await gaugeLineFor(tenantB.instanceId);
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    expect(lineA).toContain(`client_id="${tenantA.clientId}"`);
    expect(lineB).toContain(`client_id="${tenantB.clientId}"`);
    // Neither line carries the OTHER tenant's client_id or instance_id.
    expect(lineA).not.toContain(tenantB.clientId);
    expect(lineA).not.toContain(tenantB.instanceId);
    expect(lineB).not.toContain(tenantA.clientId);
    expect(lineB).not.toContain(tenantA.instanceId);
  });
});
