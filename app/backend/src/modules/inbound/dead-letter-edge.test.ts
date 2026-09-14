import '../realtime/__test-support__/stub-wp-server-kit-env.js';
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
 * dead-letter-edge.test.ts (P21 E3 hardening) - adversarial classify/size
 * inputs and boundary chatJid/waMsgId values beyond the sibling
 * `dead-letter.test.ts`. Every case is deterministic: fakes only.
 */

describe('classifyInboundError edge cases', () => {
  it('null_and_undefined_classify_as_unknown', () => {
    expect(classifyInboundError(null)).toBe('unknown');
    expect(classifyInboundError(undefined)).toBe('unknown');
  });

  it('a_pg_error_with_code_but_no_name_classifies_by_pg_code_only', () => {
    const pgError = { code: '40001' };
    expect(classifyInboundError(pgError)).toBe('pg_40001');
  });

  it('an_aggregate_error_classifies_by_its_own_name', () => {
    const aggregate = new AggregateError([new Error('a'), new Error('b')], 'multiple failures');
    expect(classifyInboundError(aggregate)).toBe('AggregateError');
  });

  it('a_200_char_error_name_is_truncated_to_64_chars', () => {
    const longName = 'E'.repeat(200);
    const err = { name: longName };
    const result = classifyInboundError(err);
    expect(result).toHaveLength(64);
    expect(result).toBe('E'.repeat(64));
  });

  it('an_error_name_containing_a_phone_number_has_only_the_digits_survive_sanitisation', () => {
    // The sanitiser strips everything except [A-Za-z0-9_] - a phone number
    // embedded in a name is not itself PII once isolated as bare digits (no
    // country-code '+' or JID/domain context survives), but assert the
    // EXACT current behaviour rather than a vague "no digits" bound.
    const err = { name: 'Error919876543210Occurred' };
    expect(classifyInboundError(err)).toBe('Error919876543210Occurred');
  });

  it('an_error_name_containing_a_single_quote_has_the_quote_stripped', () => {
    const err = { name: "Weird'Name" };
    expect(classifyInboundError(err)).toBe('WeirdName');
  });

  it('a_name_that_sanitises_to_the_empty_string_falls_back_to_unknown', () => {
    const err = { name: "'''---   " };
    expect(classifyInboundError(err)).toBe('unknown');
  });
});

describe('approximateRawSize edge cases', () => {
  it('a_bigint_containing_object_cannot_be_serialised_and_returns_null', () => {
    // JSON.stringify throws on a bigint (TypeError: Do not know how to
    // serialize a BigInt) - approximateRawSize's try/catch returns null,
    // never throws.
    const withBigInt = { count: 10n };
    expect(approximateRawSize(withBigInt)).toBeNull();
  });

  it('undefined_itself_serialises_to_the_undefined_sentinel_and_returns_null', () => {
    // JSON.stringify(undefined) === undefined (not a string) - the
    // function's own `if (serialised === undefined) return null` branch.
    expect(approximateRawSize(undefined)).toBeNull();
  });

  it('a_ten_megabyte_string_returns_a_number_and_never_throws', () => {
    const tenMb = 'a'.repeat(10 * 1024 * 1024);
    let size: number | null = null;
    expect(() => {
      size = approximateRawSize({ text: tenMb });
    }).not.toThrow();
    expect(typeof size).toBe('number');
    expect(size).toBe(Buffer.byteLength(JSON.stringify({ text: tenMb })));
  });
});

interface FakeQuery {
  sql: string;
  params: unknown[];
}

function makeFakeTenantDb(): { tenantDb: DeadLetterDeps['tenantDb']; calls: FakeQuery[] } {
  const calls: FakeQuery[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
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

describe('writeInboundDeadLetter boundary chatJid/waMsgId values', () => {
  it('an_empty_or_whitespace_only_chat_jid_writes_a_null_hash_same_as_null', async () => {
    // FIXED: an empty/whitespace-only string is never a real jid - hashing
    // it would produce a misleadingly "present" hash for a jid that was
    // never actually known. `chatJid` is now treated as `null` (no hash
    // written) when it is `null` OR trims to the empty string.
    const { tenantDb, calls } = makeFakeTenantDb();
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn: vi.fn() },
      },
      { waMsgId: 'MSG-1', chatJid: '', errorClass: 'Error', rawSize: null },
    );
    await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn: vi.fn() },
      },
      { waMsgId: 'MSG-2', chatJid: '   ', errorClass: 'Error', rawSize: null },
    );

    // params: [clientId, instanceId, waMsgId, chatJidHash, errorClass, rawSize]
    expect(calls[0]!.params[3]).toBeNull();
    expect(calls[1]!.params[3]).toBeNull();
  });

  it('a_null_chat_jid_writes_a_null_hash_not_a_hash_of_the_empty_string', async () => {
    const { tenantDb, calls } = makeFakeTenantDb();
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn: vi.fn() },
      },
      { waMsgId: 'MSG-1', chatJid: null, errorClass: 'Error', rawSize: null },
    );

    const insertCall = calls[0]!;
    expect(insertCall.params[3]).toBeNull();
  });

  it('a_wa_msg_id_longer_than_512_chars_is_passed_through_unmodified_the_row_still_writes', async () => {
    // No truncation logic exists in writeInboundDeadLetter for waMsgId -
    // document the actual (pass-through) behaviour. The DB column is a
    // plain `text` with no length CHECK constraint (migration 0063), so
    // this succeeds at the fake-query layer; a real-Postgres length limit
    // (if any) is out of this unit test's scope.
    const longWaMsgId = 'M'.repeat(600);
    const { tenantDb, calls } = makeFakeTenantDb();
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const outcome = await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: 'client-1',
        instanceId: 'instance-1',
        metrics,
        logger: { warn: vi.fn() },
      },
      { waMsgId: longWaMsgId, chatJid: null, errorClass: 'Error', rawSize: null },
    );

    expect(outcome).toBe('written');
    const insertCall = calls[0]!;
    expect(insertCall.params[2]).toBe(longWaMsgId);
    expect((insertCall.params[2] as string).length).toBe(600);
  });
});
