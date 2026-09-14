import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error.js';

/**
 * describe-error.c2.test.ts (P25 SESSION-PROTOCOL C2 edge-case pass) - hunt
 * items not already in describe-error.test.ts: a non-string/non-number
 * `code` (object/array) is dropped rather than stringified into
 * "[object Object]"; an AggregateError with sentinel-bearing inner error
 * messages never leaks them (only its own name is used); a pg error whose
 * top-level `message` (not just `detail`) carries a value never leaks
 * either, since describeError never reads `.message` at all.
 */

describe('a_non_string_non_number_code_is_dropped_not_stringified', () => {
  it('an object code is never rendered as [object Object]', () => {
    const err = Object.assign(new Error('irrelevant'), {
      name: 'WeirdError',
      code: { nested: 'SENTINEL_CODE_OBJECT' },
    });

    const result = describeError(err);

    expect(result).toBe('WeirdError');
    expect(result).not.toContain('[object Object]');
    expect(result).not.toContain('SENTINEL_CODE_OBJECT');
  });

  it('an array code is never rendered as a stringified array', () => {
    const err = Object.assign(new Error('irrelevant'), {
      name: 'WeirdError',
      code: ['SENTINEL_CODE_ARRAY'],
    });

    const result = describeError(err);

    expect(result).toBe('WeirdError');
    expect(result).not.toContain('SENTINEL_CODE_ARRAY');
  });
});

describe('aggregate_error_never_leaks_its_inner_errors_messages', () => {
  it('only the AggregateError name is used, never .errors[].message', () => {
    const inner1 = new Error('SENTINEL_INNER_MESSAGE_ONE');
    const inner2 = new Error('SENTINEL_INNER_MESSAGE_TWO');
    const aggregate = new AggregateError([inner1, inner2], 'SENTINEL_AGGREGATE_TOP_MESSAGE');

    const result = describeError(aggregate);

    expect(result).toBe('AggregateError');
    expect(result).not.toContain('SENTINEL_INNER_MESSAGE_ONE');
    expect(result).not.toContain('SENTINEL_INNER_MESSAGE_TWO');
    expect(result).not.toContain('SENTINEL_AGGREGATE_TOP_MESSAGE');
  });

  it('an AggregateError carrying a pg-shaped code still surfaces only name+code', () => {
    const inner = Object.assign(new Error('SENTINEL_INNER_PG_DETAIL'), { code: '23505' });
    const aggregate = Object.assign(new AggregateError([inner], 'SENTINEL_TOP'), {
      code: '08006',
    });

    const result = describeError(aggregate);

    expect(result).toBe('AggregateError (08006)');
    expect(result).not.toContain('SENTINEL_INNER_PG_DETAIL');
    expect(result).not.toContain('SENTINEL_TOP');
  });
});

describe('a_pg_errors_own_top_level_message_never_leaks_either', () => {
  it('describeError never reads .message at all, even when the message (not detail) carries a value', () => {
    const err = Object.assign(
      new Error('invalid input syntax for type uuid: "SENTINEL_MESSAGE_VALUE"'),
      { name: 'error', code: '22P02' },
    );

    const result = describeError(err);

    expect(result).toBe('error (22P02)');
    expect(result).not.toContain('SENTINEL_MESSAGE_VALUE');
  });
});
