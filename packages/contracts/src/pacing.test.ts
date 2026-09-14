import { describe, expect, it } from 'vitest';
import { ackFanoutInputSchema, pendingFanoutAckItemSchema } from './pacing.js';

/**
 * pacing.test.ts (P14 E3 edge pass) - schema-level edge cases for the
 * duplicate fan-out ack contract: a fingerprint hex string of the wrong
 * length (too short, too long, uppercase, non-hex characters) must be
 * rejected at the Zod boundary before it ever reaches `ackFanout`, and
 * `pendingFanoutAckItemSchema` must reject any attempt to smuggle a message
 * body through `sampleBody`.
 */
describe('ackFanoutInputSchema', () => {
  const validFingerprint = 'a'.repeat(64);

  it('accepts_a_valid_64_char_lowercase_hex_fingerprint', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: validFingerprint,
    });
    expect(result.success).toBe(true);
  });

  it('rejects_a_fingerprint_shorter_than_64_hex_characters', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: 'a'.repeat(63),
    });
    expect(result.success).toBe(false);
  });

  it('rejects_a_fingerprint_longer_than_64_hex_characters', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: 'a'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects_uppercase_hex', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: 'A'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects_non_hex_characters', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: `${'a'.repeat(63)}z`,
    });
    expect(result.success).toBe(false);
  });

  it('rejects_an_empty_fingerprint', () => {
    const result = ackFanoutInputSchema.safeParse({ localDate: '2026-09-02', fingerprint: '' });
    expect(result.success).toBe(false);
  });

  it('strict_mode_rejects_an_unknown_extra_field', () => {
    const result = ackFanoutInputSchema.safeParse({
      localDate: '2026-09-02',
      fingerprint: validFingerprint,
      extra: 'smuggled',
    });
    expect(result.success).toBe(false);
  });
});

describe('pendingFanoutAckItemSchema', () => {
  it('accepts_an_item_with_no_sampleBody_field', () => {
    const result = pendingFanoutAckItemSchema.safeParse({
      localDate: '2026-09-02',
      fingerprintHex: 'a'.repeat(64),
      recipientCount: 501,
    });
    expect(result.success).toBe(true);
  });

  it('rejects_an_item_that_smuggles_a_sampleBody_string', () => {
    const result = pendingFanoutAckItemSchema.safeParse({
      localDate: '2026-09-02',
      fingerprintHex: 'a'.repeat(64),
      recipientCount: 501,
      sampleBody: 'Big sale today!',
    });
    expect(result.success).toBe(false);
  });
});
