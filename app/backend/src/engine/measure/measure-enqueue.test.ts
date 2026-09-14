import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { createPool } from '@wp/db';
import { DEFAULT_BAND_WEIGHTS } from '@wp/domain';
import { createMeasureEnqueue } from './measure-enqueue.js';
import { wakeChannel } from '../queue/wake.js';

/**
 * measure-enqueue.test.ts (P26) - the shared measurement enqueue port's unit
 * test. A fake pool and a fake redis record every call, so each assertion
 * below is an EXACT value (statement count, channel string, band weight),
 * never a bound. Does not reach `@wp/server-kit` (only `@wp/db`'s
 * `createPool` TYPE, `@wp/domain`, and `engine/queue/wake.ts` ->
 * `platform/redis.ts`, which imports ioredis only), so no
 * `stub-wp-server-kit-env` import is needed here - same reasoning as the
 * sibling `send-load-driver.test.ts` header.
 */

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakePool(): { pool: ReturnType<typeof createPool>; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as ReturnType<typeof createPool>;
  return { pool, queries };
}

function fakeRedis(publishImpl?: () => Promise<number>): {
  redis: Redis;
  published: { channel: string; message: string }[];
} {
  const published: { channel: string; message: string }[] = [];
  const redis = {
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      if (publishImpl) return publishImpl();
      return 1;
    },
  } as unknown as Redis;
  return { redis, published };
}

const JOB = {
  clientId: '11111111-1111-4111-8111-111111111111',
  instanceId: '22222222-2222-4222-8222-222222222222',
  recipientJid: '15550001111@s.whatsapp.net',
  text: 'hello',
  idempotencyKey: 'idem-1',
};

describe('createMeasureEnqueue', () => {
  it('runs exactly one durable insert then publishes exactly one wake on the tenant channel', async () => {
    const { pool, queries } = fakePool();
    const { redis, published } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await enqueue(JOB);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('INSERT INTO message_jobs');
    expect(queries[0]?.text).toContain('INSERT INTO message_job_refs');
    expect(queries[0]?.values[0]).toBe(JOB.clientId);
    expect(queries[0]?.values[1]).toBe(JOB.instanceId);
    expect(queries[0]?.values[5]).toBe(JOB.idempotencyKey);

    expect(published).toEqual([
      { channel: wakeChannel('test', JOB.clientId, JOB.instanceId), message: '1' },
    ]);
    // The channel shape itself is `wake.ts#wakeChannel`'s contract (asserted
    // in its own unit test); repeating the raw `wp:` literal here would trip
    // the `wp/key-construction` guard, which forbids hand-built key strings
    // outside `platform/redis`. What matters here is that the wake goes to
    // THIS tenant's channel for the env we were constructed with.
    expect(published[0]?.channel).toContain(JOB.instanceId);
  });

  it('swallows a wake publish rejection - the enqueue still resolves (the safety poll is the correctness path)', async () => {
    const { pool, queries } = fakePool();
    const { redis, published } = fakeRedis(() => Promise.reject(new Error('redis down')));
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await expect(enqueue(JOB)).resolves.toBeUndefined();

    expect(queries).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('propagates a unique-violation (idempotency replay) rejection from the insert - never swallowed', async () => {
    // Idempotency/replay (C2): a second enqueue with the same idempotencyKey
    // hits `UNIQUE(client_id, idempotency_key)` at the storage layer and the
    // pool driver rejects - this module must let that propagate untouched
    // (it has no dedupe-then-return-original-job logic of its own; that
    // policy lives at the API layer, not in a measurement harness).
    const queries: RecordedQuery[] = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        const err = new Error(
          'duplicate key value violates unique constraint "message_job_refs_client_id_idempotency_key_key"',
        ) as Error & { code: string };
        err.code = '23505';
        throw err;
      },
    } as unknown as ReturnType<typeof createPool>;
    const { redis, published } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await expect(enqueue(JOB)).rejects.toThrow(/duplicate key/);
    // No wake is published for a job that never durably committed.
    expect(published).toHaveLength(0);
  });

  it('accepts an empty text payload and still commits exactly one insert', async () => {
    const { pool, queries } = fakePool();
    const { redis } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await enqueue({ ...JOB, text: '' });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.values[3]).toBe(JSON.stringify({ text: '' }));
  });

  it('accepts a huge text payload (1 MiB) without truncation before the query call', async () => {
    const hugeText = 'x'.repeat(1024 * 1024);
    const { pool, queries } = fakePool();
    const { redis } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await enqueue({ ...JOB, text: hugeText });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.values[3]).toBe(JSON.stringify({ text: hugeText }));
  });

  it('two tenants enqueueing the same recipient produce two independent inserts, each with its own client_id', async () => {
    const { pool, queries } = fakePool();
    const { redis, published } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });
    const otherClientId = '33333333-3333-4333-8333-333333333333';

    await enqueue(JOB);
    await enqueue({ ...JOB, clientId: otherClientId, idempotencyKey: 'idem-2' });

    expect(queries).toHaveLength(2);
    expect(queries[0]?.values[0]).toBe(JOB.clientId);
    expect(queries[1]?.values[0]).toBe(otherClientId);
    // Same recipient on both, but the wake channel carries the differing
    // instance/client identity - never a shared channel across tenants.
    expect(published[0]?.channel).not.toBe(published[1]?.channel);
  });

  it('binds priority_rank to the NORMAL band weight, never the unclaimable literal 10', async () => {
    const { pool, queries } = fakePool();
    const { redis } = fakeRedis();
    const enqueue = createMeasureEnqueue({ pool, redisCtl: redis, env: 'test' });

    await enqueue(JOB);

    const sql = queries[0]?.text ?? '';
    expect(DEFAULT_BAND_WEIGHTS.NORMAL).toBe(3);
    expect(sql).toContain(`'normal', ${String(DEFAULT_BAND_WEIGHTS.NORMAL)},`);
    expect(sql).not.toContain('10');
  });
});
