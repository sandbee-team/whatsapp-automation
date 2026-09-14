import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import {
  approximateRawSize,
  classifyInboundError,
  writeInboundDeadLetter,
  type DeadLetterDeps,
} from './dead-letter.js';

/**
 * dead-letter.test.ts (P21 Unit U6a, step 7) - pure-logic proof of
 * `classifyInboundError`/`approximateRawSize` plus `writeInboundDeadLetter`
 * against a fake `TenantDb`/`TenantQueryable` (no real Postgres - that proof
 * belongs to a future integration test). Every case is deterministic; no
 * sleeps, no live clock.
 */

describe('classifyInboundError', () => {
  it('classify_error_is_bounded_and_never_leaks_the_message', () => {
    const pgError = { code: '23505', message: 'duplicate key value ... 919876543210' };
    expect(classifyInboundError(pgError)).toBe('pg_23505');

    expect(classifyInboundError(new TypeError('x'))).toBe('TypeError');

    expect(classifyInboundError({ name: 'Weird Name!' })).toBe('WeirdName');

    expect(classifyInboundError('string')).toBe('unknown');
  });
});

describe('approximateRawSize', () => {
  it('approximate_raw_size_measures_and_forgets', () => {
    const size = approximateRawSize({ a: 1, b: 'two' });
    expect(size).toBe(Buffer.byteLength(JSON.stringify({ a: 1, b: 'two' })));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(approximateRawSize(circular)).toBeNull();
  });
});

interface FakeQuery {
  sql: string;
  params: unknown[];
}

function makeFakeTenantDb(options: { shouldThrow?: boolean }): {
  tenantDb: DeadLetterDeps['tenantDb'];
  calls: FakeQuery[];
} {
  const calls: FakeQuery[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (options.shouldThrow) {
        throw new Error('insert failed');
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const tenantDb = {
    withTenant: vi.fn(async (_clientId: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  } as unknown as DeadLetterDeps['tenantDb'];
  return { tenantDb, calls };
}

describe('writeInboundDeadLetter', () => {
  it('a_dead_letter_row_contains_no_body_jid_or_phone_number', async () => {
    const chatJid = '919876543210@s.whatsapp.net';
    const bodySentinel = 'SEEDED BODY 919876543210';
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const warn = vi.fn();
    const { tenantDb, calls } = makeFakeTenantDb({});

    const outcome = await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn },
      },
      {
        waMsgId: 'MSG-1',
        chatJid,
        errorClass: classifyInboundError(new Error(bodySentinel)),
        rawSize: approximateRawSize({ text: bodySentinel }),
      },
    );

    expect(outcome).toBe('written');
    expect(calls).toHaveLength(1);
    const insertCall = calls[0]!;
    expect(insertCall.sql).toMatch(/INSERT INTO inbound_dead_letters/);
    const expectedHash = createHash('sha256').update(chatJid).digest();
    expect(insertCall.params).toEqual([
      'client-1',
      'instance-1',
      'MSG-1',
      expectedHash,
      'Error',
      Buffer.byteLength(JSON.stringify({ text: bodySentinel })),
    ]);

    const flattened = JSON.stringify(insertCall.params, (_key, value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        (value as { type: unknown }).type === 'Buffer' &&
        'data' in value
      ) {
        return Buffer.from((value as { data: number[] }).data).toString('hex');
      }
      return value;
    });
    expect(flattened).not.toContain('919876543210');
    expect(flattened).not.toContain(chatJid);
    expect(flattened).not.toContain(bodySentinel);

    for (const call of warn.mock.calls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain('919876543210');
      expect(serialised).not.toContain(chatJid);
      expect(serialised).not.toContain(bodySentinel);
    }
  });

  it('a_failing_dead_letter_write_counts_persist_failed_and_never_throws', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const { tenantDb } = makeFakeTenantDb({ shouldThrow: true });

    const outcome = await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn: vi.fn() },
      },
      {
        waMsgId: 'MSG-1',
        chatJid: null,
        errorClass: 'SomeError',
        rawSize: null,
      },
    );

    expect(outcome).toBe('persist_failed');
    expect(
      (await metrics.inboundDeadLettersTotal.get()).values.find(
        (v) => v.labels.error_class === 'persist_failed',
      )?.value,
    ).toBe(1);
  });
});
