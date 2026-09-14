import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { buildHarness, post, validBody } from './leads-routes-test-support.js';

/**
 * leads-edge-cases.test.ts (P29 session 1, E3 hardening) - crash-in-the-
 * middle, replay, and empty/huge input edge cases beyond
 * `leads.routes.test.ts`. Clock-boundary, retry-storm, ordering, and CORS
 * cases live in the sibling `leads-edge-cases-2.test.ts` (300-line cap).
 */

describe('leads_crash_in_the_middle', () => {
  it('a_repo_that_throws_maps_to_500_internal_with_no_driver_message_and_no_accepted_outcome', async () => {
    const harness = buildHarness({
      repo: {
        insert: async () => {
          throw new Error(
            'relation "leads" does not exist: pg error at table leads column ip_hash',
          );
        },
      },
    });
    const now = harness.clock.current;
    const response = await post(harness, validBody(now), { ip: '198.51.100.40' });

    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toMatch(/leads/i);
    expect(body.error.message).not.toMatch(/pg error/i);
    expect(body.error.message).not.toMatch(/ip_hash/i);
    expect(harness.outcomes).not.toContain('accepted');
  });

  it('onOutcome_accepted_fires_only_after_repo_insert_resolves', async () => {
    const order: string[] = [];
    const harness = buildHarness({
      repo: {
        insert: async () => {
          order.push('repo.insert');
          return { id: 'fixed-id' };
        },
      },
      onOutcome: (o) => {
        order.push(`outcome:${o}`);
      },
    });
    const now = harness.clock.current;
    const response = await post(harness, validBody(now), { ip: '198.51.100.41' });

    expect(response.statusCode).toBe(202);
    expect(order).toEqual(['repo.insert', 'outcome:accepted']);
  });
});

describe('leads_replay', () => {
  it('the_same_valid_body_posted_twice_from_the_same_ip_inserts_two_rows_leads_are_not_idempotent_by_design', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const body = validBody(now);

    const first = await post(harness, body, { ip: '198.51.100.42' });
    const second = await post(harness, body, { ip: '198.51.100.42' });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(harness.rows.length).toBe(2);
    expect(harness.rows[0]).toEqual(harness.rows[1]);
    // Documented expectation: the leads table (migration 0074) carries no
    // idempotency/dedupe key, and the route performs no pre-insert lookup -
    // a genuine duplicate submission (e.g. double-click) creates two rows.
    // This is a deliberate design choice for a marketing contact form (not
    // a durable job/wallet write core invariant 3 governs), not a bug.
  });
});

describe('leads_empty_and_huge_inputs', () => {
  it('an_empty_body_is_400', async () => {
    const harness = buildHarness();
    const response = await post(harness, {}, { ip: '198.51.100.43' });
    expect(response.statusCode).toBe(400);
    expect(harness.rows.length).toBe(0);
  });

  it('a_1mb_message_never_500s_and_never_inserts_a_row', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { message: 'a'.repeat(1024 * 1024) }), {
      ip: '198.51.100.44',
    });
    // A body this size exceeds the route's 16 KiB `bodyLimit` (leads.routes.ts)
    // well before zod ever sees it - pin 413, not a loose 400-or-413 bound.
    expect(response.statusCode).toBe(413);
    expect(harness.rows.length).toBe(0);
  });

  it('name_of_120_chars_is_ok_121_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const ok = await post(harness, validBody(now, { name: 'a'.repeat(120) }), {
      ip: '198.51.100.45',
    });
    expect(ok.statusCode).toBe(202);

    const tooLong = await post(harness, validBody(now, { name: 'a'.repeat(121) }), {
      ip: '198.51.100.46',
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('email_is_stored_lowercased_even_when_submitted_uppercase', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { email: 'ADA@EXAMPLE.COM' }), {
      ip: '198.51.100.47',
    });
    expect(response.statusCode).toBe(202);
    expect(harness.rows[0]?.email).toBe('ada@example.com');
  });

  it('email_a_at_b_three_chars_is_rejected_by_zod_email', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { email: 'a@b' }), {
      ip: '198.51.100.48',
    });
    expect(response.statusCode).toBe(400);
  });

  it('phone_e164_missing_leading_country_digit_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { phoneE164: '+0123456789' }), {
      ip: '198.51.100.49',
    });
    expect(response.statusCode).toBe(400);
  });

  it('a_utm_value_of_201_chars_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { utm: { utm_source: 'a'.repeat(201) } }), {
      ip: '198.51.100.50',
    });
    expect(response.statusCode).toBe(400);
  });

  it('a_utm_key_with_a_hyphen_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { utm: { 'utm-source': 'x' } }), {
      ip: '198.51.100.51',
    });
    expect(response.statusCode).toBe(400);
  });

  it('a_nested_object_utm_value_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(
      harness,
      validBody(now, { utm: { utm_source: { nested: true } } }),
      { ip: '198.51.100.52' },
    );
    expect(response.statusCode).toBe(400);
  });

  it('an_uppercase_source_is_400', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now, { source: 'Contact' }), {
      ip: '198.51.100.53',
    });
    expect(response.statusCode).toBe(400);
  });

  it('a_120_char_devanagari_name_is_accepted_code_point_length_semantics', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    // Devanagari letters here are single UTF-16 code units each (BMP), so
    // code-point length and UTF-16 length agree for this script - this case
    // does not by itself prove zod counts code points for astral (surrogate
    // pair) characters; see the documented gap below.
    const name = 'अ'.repeat(120);
    const response = await post(harness, validBody(now, { name }), {
      ip: '198.51.100.54',
    });
    expect(response.statusCode).toBe(202);
  });

  it('documented_gap_zod_max_counts_utf16_code_units_not_code_points_for_astral_characters', () => {
    // z.string().max(120) uses JS `.length`, which counts UTF-16 code
    // units: an astral character (e.g. an emoji outside the BMP) counts as
    // 2 units but 1 code point, while Postgres `char_length` counts
    // characters (code points). This is a genuine unit mismatch between
    // the two layers, documented here rather than exercised over HTTP
    // because it never causes a false ACCEPT (zod is the stricter of the
    // two for astral input) - only a false REJECT of some valid
    // long-emoji names, which is a UX defect, not a safety one.
    const astral = '\u{1F600}'; // outside the BMP: 1 code point, 2 UTF-16 units
    expect(astral.length).toBe(2);
    expect(Array.from(astral).length).toBe(1);
  });
});
