import { describe, expect, it } from 'vitest';
import { mediaAssetSchema, mediaKindSchema, mediaIdParamSchema } from './media.js';

/**
 * media.test.ts (P34 U-upload) - pins the wire shape: exactly two kinds,
 * `storageKey` is NEVER a field of `mediaAssetSchema` (ADR 0052 accepted
 * item 2 - the storage key is internal, the caller only ever holds a
 * `mediaId`), and `.strict()` rejects an unplanned extra field.
 */
describe('media contract', () => {
  it('mediaKindSchema accepts exactly image and document', () => {
    expect(mediaKindSchema.options).toEqual(['image', 'document']);
    expect(mediaKindSchema.safeParse('video').success).toBe(false);
    expect(mediaKindSchema.safeParse('audio').success).toBe(false);
  });

  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  it('mediaAssetSchema never exposes a storage key field, even if one is present on the input object', () => {
    const withStorageKey = {
      id: VALID_UUID,
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
      fileName: null,
      createdAt: '2026-09-14T10:00:00.000Z',
      storageKey: `clients/${VALID_UUID}/media/2026/09/x.png`,
    };

    const result = mediaAssetSchema.safeParse(withStorageKey);
    expect(result.success).toBe(false); // .strict() rejects the unplanned extra field
  });

  it('mediaAssetSchema accepts the exact accepted-scope shape', () => {
    const valid = {
      id: VALID_UUID,
      kind: 'document',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      fileName: 'invoice.pdf',
      createdAt: '2026-09-14T10:00:00.000Z',
    };

    expect(mediaAssetSchema.safeParse(valid)).toMatchObject({ success: true });
  });

  it('mediaIdParamSchema requires a uuid and rejects an extra field', () => {
    expect(mediaIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
    expect(mediaIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(
      mediaIdParamSchema.safeParse({
        id: VALID_UUID,
        extra: 'x',
      }).success,
    ).toBe(false);
  });
});
