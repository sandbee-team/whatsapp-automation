import { describe, expect, it } from 'vitest';
import { createMessageInputSchema } from './messages.js';

/**
 * messages.media-kind.test.ts (P34 Unit B, ADR 0052 accepted scope) -
 * `createMessageInputSchema`'s `image`/`document` branches, split out of
 * `messages.test.ts` purely for that file's max-lines cap (same discipline
 * every other split in this repo follows).
 */

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'text',
    recipient: '+919876543210',
    payload: { text: 'hello there' },
    priority: 'normal',
    ...overrides,
  };
}

describe('createMessageInputSchema - image/document kinds (P34)', () => {
  it('accepts_a_minimal_valid_image_request', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({ kind: 'image', payload: { mediaId: '0190f1e4-0000-7000-8000-000000000001' } }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts_an_image_request_with_a_caption', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({
        kind: 'image',
        payload: { mediaId: '0190f1e4-0000-7000-8000-000000000001', caption: 'look at this' },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts_a_minimal_valid_document_request', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({
        kind: 'document',
        payload: { mediaId: '0190f1e4-0000-7000-8000-000000000002' },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('a_document_request_carrying_its_own_file_name_is_rejected', () => {
    // Accepted scope item 4: the file name comes from the stored asset,
    // never the request - `.strict()` on documentPayloadSchema rejects a
    // caller-supplied `fileName` outright, it is never silently stripped.
    const result = createMessageInputSchema.safeParse(
      validInput({
        kind: 'document',
        payload: {
          mediaId: '0190f1e4-0000-7000-8000-000000000002',
          fileName: 'invoice.pdf',
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('a_document_request_carrying_its_own_mime_type_is_rejected', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({
        kind: 'document',
        payload: {
          mediaId: '0190f1e4-0000-7000-8000-000000000002',
          mimetype: 'application/pdf',
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('an_image_request_with_a_non_uuid_media_id_is_rejected', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({ kind: 'image', payload: { mediaId: 'not-a-uuid' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects_an_unknown_kind_entirely', () => {
    const result = createMessageInputSchema.safeParse(
      validInput({
        kind: 'sticker',
        payload: { mediaId: '0190f1e4-0000-7000-8000-000000000001' },
      }),
    );
    expect(result.success).toBe(false);
  });
});
