import { describe, expect, it } from 'vitest';
import {
  createMessageInputSchema,
  createMessageHeadersSchema,
  createMessageOutputSchema,
  recipientSchema,
} from './messages.js';

const basePayload = { text: 'hello there' };

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'text',
    recipient: '+919876543210',
    payload: basePayload,
    priority: 'normal',
    ...overrides,
  };
}

/** Mirrors `messages.ts`'s own hand-computed UTF-8 byte-length helper (no `Buffer`/`TextEncoder` - this package ships no Node/DOM globals). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const codeUnit = text.codePointAt(i) as number;
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

describe('messages contract', () => {
  describe('createMessageHeadersSchema', () => {
    it('a_request_without_an_idempotency_key_is_rejected_by_the_schema', () => {
      const result = createMessageHeadersSchema.safeParse({});

      expect(result.success).toBe(false);
    });

    it('a_request_with_a_blank_idempotency_key_is_rejected_by_the_schema', () => {
      const result = createMessageHeadersSchema.safeParse({ 'idempotency-key': '   ' });

      expect(result.success).toBe(false);
    });

    it('a_request_with_a_valid_idempotency_key_is_accepted', () => {
      const result = createMessageHeadersSchema.safeParse({
        'idempotency-key': 'a-real-key-123',
      });

      expect(result.success).toBe(true);
    });

    it('a_255_character_idempotency_key_is_accepted_at_the_documented_max', () => {
      const key = 'k'.repeat(255);
      const result = createMessageHeadersSchema.safeParse({ 'idempotency-key': key });

      expect(result.success).toBe(true);
    });

    it('a_256_character_idempotency_key_is_rejected_one_past_the_max', () => {
      const key = 'k'.repeat(256);
      const result = createMessageHeadersSchema.safeParse({ 'idempotency-key': key });

      expect(result.success).toBe(false);
    });

    it('a_whitespace_only_idempotency_key_at_255_characters_is_still_rejected', () => {
      // .trim().min(1) must reject an all-whitespace key regardless of its
      // raw length - trimming happens before the length floor is checked.
      const key = ' '.repeat(255);
      const result = createMessageHeadersSchema.safeParse({ 'idempotency-key': key });

      expect(result.success).toBe(false);
    });
  });

  describe('payload byte-size limit (mirrors db/migrations/0007 mj_payload_size)', () => {
    it('a_payload_over_2048_bytes_is_rejected_at_the_contract', () => {
      // Exactly 2049 bytes of JSON text once stringified: build a string
      // whose stringified JSON text is exactly 2049 bytes long.
      const text = 'a'.repeat(2049 - '{"text":""}'.length);
      const input = validInput({ payload: { text } });
      const jsonBytes = utf8ByteLength(JSON.stringify(input.payload));
      expect(jsonBytes).toBe(2049);

      const result = createMessageInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('a_payload_at_exactly_2048_bytes_is_accepted', () => {
      const text = 'a'.repeat(2048 - '{"text":""}'.length);
      const input = validInput({ payload: { text } });
      const jsonBytes = utf8ByteLength(JSON.stringify(input.payload));
      expect(jsonBytes).toBe(2048);

      const result = createMessageInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('a_multi_byte_emoji_payload_counts_its_real_utf8_byte_length_not_character_length', () => {
      // A single emoji character can be 4 bytes in UTF-8 but 1 (or 2, as a
      // surrogate pair) JS "characters" - pad so the JSON text is exactly
      // 2049 bytes using the emoji's real byte length, proving byte (not
      // character) counting is what rejects it.
      const emoji = '\u{1F600}'; // 4 bytes in UTF-8
      const emojiBytes = utf8ByteLength(emoji);
      expect(emojiBytes).toBe(4);

      const overhead = '{"text":""}'.length;
      const remainingBytes = 2049 - overhead;
      const emojiCount = Math.floor(remainingBytes / emojiBytes);
      const text = emoji.repeat(emojiCount) + 'a'.repeat(remainingBytes - emojiCount * emojiBytes);
      const input = validInput({ payload: { text } });
      const jsonBytes = utf8ByteLength(JSON.stringify(input.payload));
      expect(jsonBytes).toBe(2049);

      const result = createMessageInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('an_empty_image_payload_is_rejected_by_the_kind_specific_shape_not_the_size_envelope', () => {
      // P34 (ADR 0052 accepted scope) closes the per-kind payload shape -
      // `{}` is well under 2048 bytes but `image` REQUIRES `mediaId`, so this
      // is rejected by the discriminated union, not the byte-size refine.
      const input = validInput({ kind: 'image', payload: {} });
      const jsonBytes = utf8ByteLength(JSON.stringify(input.payload));
      expect(jsonBytes).toBe(2);

      const result = createMessageInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });

  describe('recipientSchema (E.164 OR @g.us group JID)', () => {
    it('accepts_a_valid_e164_number', () => {
      expect(recipientSchema.safeParse('+919876543210').success).toBe(true);
    });

    it('accepts_a_group_jid', () => {
      expect(recipientSchema.safeParse('120363012345678901@g.us').success).toBe(true);
    });

    it('rejects_a_bare_local_number_without_plus', () => {
      expect(recipientSchema.safeParse('919876543210').success).toBe(false);
    });

    it('rejects_a_non_group_jid', () => {
      expect(recipientSchema.safeParse('919876543210@s.whatsapp.net').success).toBe(false);
    });

    it('rejects_an_e164_number_starting_with_zero', () => {
      expect(recipientSchema.safeParse('+0876543210').success).toBe(false);
    });

    it('rejects_an_e164_number_over_15_digits', () => {
      expect(recipientSchema.safeParse('+1234567890123456').success).toBe(false);
    });
  });

  describe('createMessageInputSchema', () => {
    it('accepts_a_minimal_valid_text_request', () => {
      const result = createMessageInputSchema.safeParse(validInput());
      expect(result.success).toBe(true);
    });

    it('accepts_an_optional_scheduled_at', () => {
      const result = createMessageInputSchema.safeParse(
        validInput({ scheduledAt: '2026-09-02T10:00:00.000Z' }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects_an_invalid_priority', () => {
      const result = createMessageInputSchema.safeParse(validInput({ priority: 'urgent' }));
      expect(result.success).toBe(false);
    });

    it('rejects_an_invalid_kind', () => {
      const result = createMessageInputSchema.safeParse(validInput({ kind: 'voice' }));
      expect(result.success).toBe(false);
    });

    it('rejects_a_recipient_that_is_neither_e164_nor_a_group_jid', () => {
      const result = createMessageInputSchema.safeParse(validInput({ recipient: 'not-a-number' }));
      expect(result.success).toBe(false);
    });

    it('send_origin_cannot_be_supplied_by_a_client', () => {
      // Mandatory test 23 (P14 Unit U4): .strict() rejects every shape a
      // client might try to smuggle a pacing-exempt origin through with -
      // never silently strips the extra key and proceeds.
      expect(
        createMessageInputSchema.safeParse(validInput({ origin: 'system_reply' })).success,
      ).toBe(false);
      expect(
        createMessageInputSchema.safeParse(validInput({ sendOrigin: 'opt_out_confirmation' }))
          .success,
      ).toBe(false);
      expect(createMessageInputSchema.safeParse(validInput({ __systemReply: true })).success).toBe(
        false,
      );
    });
  });

  describe('createMessageOutputSchema', () => {
    it('shape_is_a_created_public_id_and_queued_status_in_the_success_envelope', () => {
      const result = createMessageOutputSchema.safeParse({
        data: { id: '0190f1e4-0000-7000-8000-000000000000', status: 'queued' },
        meta: { requestId: 'req-1' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects_a_status_other_than_queued', () => {
      const result = createMessageOutputSchema.safeParse({
        data: { id: '0190f1e4-0000-7000-8000-000000000000', status: 'sent' },
        meta: { requestId: 'req-1' },
      });
      expect(result.success).toBe(false);
    });
  });
});
