import { describe, expect, it } from 'vitest';
import {
  assertAllowedMedia,
  extensionForMime,
  MEDIA_CAPS_BYTES,
  MEDIA_MIME_ALLOW_LIST,
} from './media.js';

/**
 * media.test.ts (M1) - exact-value table for the caps/MIME allow-list and
 * the `extensionForMime` round-trip. Per core-invariants "units and
 * quantities": every assertion below is an EXACT expected value, never a
 * bound.
 */
describe('media caps and MIME allow-list', () => {
  it('exposes exactly the two ADR 0052 SS2.2 byte caps for this session', () => {
    expect(MEDIA_CAPS_BYTES.image).toBe(5 * 1024 * 1024);
    expect(MEDIA_CAPS_BYTES.document).toBe(20 * 1024 * 1024);
  });

  it('exposes exactly the image MIME allow-list', () => {
    expect(MEDIA_MIME_ALLOW_LIST.image).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('exposes exactly the document MIME allow-list', () => {
    expect(MEDIA_MIME_ALLOW_LIST.document).toEqual([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'text/csv',
    ]);
  });

  describe('extensionForMime', () => {
    it.each([
      ['image/jpeg', 'jpg'],
      ['image/png', 'png'],
      ['image/webp', 'webp'],
      ['application/pdf', 'pdf'],
      ['application/msword', 'doc'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['application/vnd.ms-excel', 'xls'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
      ['text/plain', 'txt'],
      ['text/csv', 'csv'],
    ])('maps %s to .%s', (mime, ext) => {
      expect(extensionForMime(mime)).toBe(ext);
    });
  });

  describe('assertAllowedMedia', () => {
    it('accepts a valid image within cap', () => {
      const result = assertAllowedMedia({
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: 1024,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts a valid document within cap', () => {
      const result = assertAllowedMedia({
        kind: 'document',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });
      expect(result).toEqual({ ok: true });
    });

    it('accepts a document exactly at the 20 MB cap', () => {
      const result = assertAllowedMedia({
        kind: 'document',
        mimeType: 'application/pdf',
        sizeBytes: 20 * 1024 * 1024,
      });
      expect(result).toEqual({ ok: true });
    });

    it('rejects an image exactly one byte over its 5 MB cap', () => {
      const result = assertAllowedMedia({
        kind: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: 5 * 1024 * 1024 + 1,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', maxBytes: 5 * 1024 * 1024 },
      });
    });

    it('rejects a document exactly one byte over its 20 MB cap', () => {
      const result = assertAllowedMedia({
        kind: 'document',
        mimeType: 'application/pdf',
        sizeBytes: 20 * 1024 * 1024 + 1,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', maxBytes: 20 * 1024 * 1024 },
      });
    });

    it('rejects a MIME type outside the kind allow-list', () => {
      const result = assertAllowedMedia({
        kind: 'image',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', mimeType: 'application/pdf', kind: 'image' },
      });
    });

    it('rejects a MIME type unknown to any kind', () => {
      const result = assertAllowedMedia({
        kind: 'document',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', mimeType: 'video/mp4', kind: 'document' },
      });
    });
  });
});
