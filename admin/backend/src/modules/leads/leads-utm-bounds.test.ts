import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { buildHarness, post, validBody } from './leads-routes-test-support.js';

/**
 * leads-utm-bounds.test.ts (P29 C1 fix round, CRITICAL 1) - proves the zod
 * `utmSchema` byte-size refine rejects a `utm` payload the DB CHECK
 * (migration 0074's `pg_column_size(utm) <= 2048`) would also reject, so a
 * boundary-passing request never reaches storage only to 500 there. See
 * `leads.routes.ts#utmSchema`.
 */

describe('leads_utm_byte_size_bound', () => {
  it('a_utm_of_10_single_letter_keys_x_200_chars_is_400_and_inserts_nothing', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const utm: Record<string, string> = {};
    'abcdefghij'.split('').forEach((key) => {
      utm[key] = 'a'.repeat(200);
    });
    // Sanity: this payload is exactly the shape the finding describes -
    // under the DB's `pg_column_size(utm) <= 2048` but only once serialised;
    // its raw JSON size is already over the 1800-byte zod refine.
    expect(Buffer.byteLength(JSON.stringify(utm), 'utf8')).toBeGreaterThan(1800);

    const response = await post(harness, validBody(now, { utm }), { ip: '198.51.100.70' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(harness.rows.length).toBe(0);
  });

  it('a_utm_whose_json_is_exactly_at_or_under_1800_bytes_is_accepted', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const utm: Record<string, string> = {};
    'abcdefghi'.split('').forEach((key) => {
      utm[key] = 'a'.repeat(190);
    });
    expect(Buffer.byteLength(JSON.stringify(utm), 'utf8')).toBeLessThanOrEqual(1800);

    const response = await post(harness, validBody(now, { utm }), { ip: '198.51.100.71' });
    expect(response.statusCode).toBe(202);
    expect(harness.rows.length).toBe(1);
  });
});
