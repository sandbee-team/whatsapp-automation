import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createPacingAdvisory, type PacingAdvisory } from './advisory.js';
import { reserve } from './index.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * reserve-advisory.integration.test.ts (P13 Unit U4, step 8) - real Redis +
 * real Postgres. Test 25 (Postgres is authoritative when Redis is wrong),
 * test 26 (Redis outage degrades but never over-sends), and the static +
 * behavioural "can never grant" proof.
 */

type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;
let advisory: PacingAdvisory;

const ENV = 'test';

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-advisory-tests',
  });
  redis = createRedis(resolveRedisUrl());
  advisory = createPacingAdvisory(redis);
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('reserve-advisory.lua', () => {
  it('the_advisory_script_can_never_return_a_grant', async () => {
    // STATIC: every `return` path in the script text is literally `0` or
    // `1` - never a variable, never anything else.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const luaText = readFileSync(path.join(here, 'scripts', 'reserve-advisory.lua'), 'utf8');
    const returnLines = luaText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('return '));
    expect(returnLines.length).toBeGreaterThan(0);
    for (const line of returnLines) {
      expect(['return 0', 'return 1']).toContain(line);
    }

    // BEHAVIOURAL: a `1` (ask Postgres) result alone never consumes a
    // pacing unit - only a REAL Postgres reserve() grant does.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 5,
    });
    const askResult = await advisory.askAdvisory({
      env: ENV,
      clientId,
      instanceId,
      ledgerDate: '2026-09-02',
      dailyCap: 5,
    });
    expect(askResult).toBe(true);

    const ledger = await pool.query('SELECT * FROM pacing_ledger WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(ledger.rows).toHaveLength(0);
  });

  it('postgres_is_authoritative_when_redis_is_wrong', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 2,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });

    // Force the Redis mirror to 0 mid-day (as if it were reset/wrong,
    // disagreeing with Postgres's own already-consumed count) by NEVER
    // calling recordGrant after real grants - the mirror silently
    // understates usage.
    const first = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(first.granted).toBe(true);
    const second = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(second.granted).toBe(true);
    // Cap (2) now exhausted in Postgres. The Redis mirror was NEVER
    // incremented (recordGrant not called) - it reads as absent/0,
    // wrongly suggesting room. The advisory alone would say "ask
    // Postgres" (never a grant on its own) - and Postgres, asked, still
    // correctly denies.
    const askResult = await advisory.askAdvisory({
      env: ENV,
      clientId,
      instanceId,
      ledgerDate: first.granted ? first.ledgerDate : '',
      dailyCap: 2,
    });
    expect(askResult).toBe(true); // mirror understated usage -> "ask Postgres"

    const third = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(third.granted).toBe(false);

    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.consumed_count).toBe(2);
  });

  it('redis_outage_degrades_but_never_over_sends', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 3,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });

    // Simulate an unreachable Redis by pointing a SEPARATE advisory
    // instance at an unroutable address - askAdvisory must degrade to
    // `true` (ask Postgres), never throw and never short-circuit to a
    // false grant.
    const brokenRedis = createRedis('redis://127.0.0.1:1');
    brokenRedis.on('error', () => {
      // Swallow ioredis's own connection-error events - this test asserts
      // on askAdvisory's return value, not on the client's event stream.
    });
    const brokenAdvisory = createPacingAdvisory(brokenRedis);

    let grants = 0;
    for (let i = 0; i < 5; i += 1) {
      const askResult = await brokenAdvisory.askAdvisory({
        env: ENV,
        clientId,
        instanceId,
        ledgerDate: '2026-09-02',
        dailyCap: 3,
      });
      expect(askResult).toBe(true); // degrade to "ask Postgres", never throw
      const outcome = await reserve({
        sql: pool,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      if (outcome.granted) grants += 1;
    }
    brokenRedis.disconnect();

    // The cap (3) is still exact - Postgres alone enforced it despite the
    // advisory being fully unreachable the whole time.
    expect(grants).toBe(3);
  });
});
