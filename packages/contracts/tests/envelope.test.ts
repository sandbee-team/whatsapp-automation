import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  ERROR_CODE_TO_HTTP_STATUS,
  errorEnvelopeSchema,
  metaSchema,
  paginationInputSchema,
  successEnvelope,
} from '../src/index.js';

describe('error code -> HTTP status table', () => {
  it('every_error_code_maps_to_exactly_one_http_status', () => {
    // No duplicate codes in the source-of-truth tuple.
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);

    // Every declared code has exactly one status entry, and vice versa -
    // the two lists agree exactly (no orphan code, no orphan status).
    const mappedCodes = Object.keys(ERROR_CODE_TO_HTTP_STATUS);
    expect(new Set(mappedCodes).size).toBe(mappedCodes.length);
    expect([...mappedCodes].sort()).toEqual([...ERROR_CODES].sort());

    for (const code of ERROR_CODES) {
      const status = ERROR_CODE_TO_HTTP_STATUS[code];
      expect(typeof status).toBe('number');
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('envelope contract shape', () => {
  it('the_error_envelope_shape_is_stable', () => {
    const errorExample = {
      error: {
        code: 'INSTANCE_PAUSED',
        message: 'Sending is paused for this WhatsApp instance.',
        details: { instanceId: '01J000000000000000000000', healthState: 'paused' },
        requestId: 'req_01J000000000000000000000',
      },
    };

    expect(errorEnvelopeSchema.parse(errorExample)).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "INSTANCE_PAUSED",
          "details": {
            "healthState": "paused",
            "instanceId": "01J000000000000000000000",
          },
          "message": "Sending is paused for this WhatsApp instance.",
          "requestId": "req_01J000000000000000000000",
        },
      }
    `);

    const successSchema = successEnvelope(z.object({ id: z.string(), status: z.string() }));
    const successExample = {
      data: { id: '01J000000000000000000001', status: 'queued' },
      meta: { requestId: 'req_01J000000000000000000001', nextCursor: 'eyJpZCI6MX0=' },
    };

    expect(successSchema.parse(successExample)).toMatchInlineSnapshot(`
      {
        "data": {
          "id": "01J000000000000000000001",
          "status": "queued",
        },
        "meta": {
          "nextCursor": "eyJpZCI6MX0=",
          "requestId": "req_01J000000000000000000001",
        },
      }
    `);

    expect(metaSchema.parse({ requestId: 'req_01J000000000000000000002' })).toMatchInlineSnapshot(`
      {
        "requestId": "req_01J000000000000000000002",
      }
    `);
  });

  it('the_success_envelope_round_trips_an_empty_data_object', () => {
    const emptySchema = successEnvelope(z.object({}));
    const example = { data: {}, meta: { requestId: 'req_01J000000000000000000003' } };

    expect(emptySchema.parse(example)).toEqual(example);
  });

  it('the_error_envelope_rejects_an_unknown_error_code', () => {
    const badExample = {
      error: {
        code: 'TOTALLY_MADE_UP_CODE',
        message: 'x',
        requestId: 'req_01J000000000000000000004',
      },
    };

    expect(() => errorEnvelopeSchema.parse(badExample)).toThrow();
  });
});

describe('paginationInputSchema boundaries', () => {
  it('limit_0_is_rejected', () => {
    expect(paginationInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('limit_101_is_rejected', () => {
    expect(paginationInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('limit_100_is_accepted_the_upper_bound_is_inclusive', () => {
    expect(paginationInputSchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it('limit_1_is_accepted_the_lower_bound_is_inclusive', () => {
    expect(paginationInputSchema.safeParse({ limit: 1 }).success).toBe(true);
  });

  it('a_negative_limit_is_rejected', () => {
    expect(paginationInputSchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  it('a_non_integer_limit_is_rejected', () => {
    expect(paginationInputSchema.safeParse({ limit: 20.5 }).success).toBe(false);
  });

  it('omitting_limit_defaults_to_20', () => {
    const parsed = paginationInputSchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it('cursor_is_optional_and_a_non_string_cursor_is_rejected', () => {
    expect(paginationInputSchema.safeParse({}).success).toBe(true);
    expect(paginationInputSchema.safeParse({ cursor: 123 }).success).toBe(false);
  });
});
