import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error.js';

describe('@wp/server-kit obs describeError', () => {
  it('a_pg_database_error_yields_name_and_code_but_never_detail_where_or_message', () => {
    const err = Object.assign(new Error('invalid input syntax for type integer: "SENTINEL_X"'), {
      name: 'error',
      code: '22P02',
      detail: 'Key (email)=(SENTINEL_Y) already exists.',
      where: 'SENTINEL_Z',
    });

    const result = describeError(err);

    expect(result).toContain('22P02');
    expect(result).not.toContain('SENTINEL_X');
    expect(result).not.toContain('SENTINEL_Y');
    expect(result).not.toContain('SENTINEL_Z');
  });

  it('a_plain_error_yields_only_its_name_never_its_message', () => {
    const result = describeError(new Error('SENTINEL_MSG'));

    expect(result).toBe('Error');
    expect(result).not.toContain('SENTINEL_MSG');
  });

  it('an_error_with_a_numeric_status_code_includes_it', () => {
    const err = Object.assign(new Error('SENTINEL_STATUS_MSG'), {
      name: 'HttpError',
      statusCode: 503,
    });

    const result = describeError(err);

    expect(result).toBe('HttpError [503]');
  });

  it('non_error_values_are_reduced_to_their_typeof', () => {
    expect(describeError('a string value')).toBe('string');
    expect(describeError(null)).toBe('object');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(42)).toBe('number');
  });
});
