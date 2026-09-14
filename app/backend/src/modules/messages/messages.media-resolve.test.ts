import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import {
  MediaAssetNotFoundError,
  payloadKindFor,
  resolveMediaIdForEnqueue,
} from './messages.media-resolve.js';

/**
 * messages.media-resolve.test.ts (P34 Unit B, ADR 0052 accepted scope) -
 * `payloadKindFor` (the pure kind -> job_kind mapping, ADR S7.1) and
 * `resolveMediaIdForEnqueue` (fail-closed 404 before any job row) against a
 * fake `TenantQueryable` - no real Postgres needed to prove either.
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const MEDIA_ID = '22222222-2222-2222-2222-222222222222';

function fakeTxReturning(row: Record<string, unknown> | undefined): TenantQueryable {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  };
}

describe('payloadKindFor', () => {
  it('maps_image_and_document_to_media', () => {
    expect(payloadKindFor('image')).toBe('media');
    expect(payloadKindFor('document')).toBe('media');
  });

  it('maps_text_to_text', () => {
    expect(payloadKindFor('text')).toBe('text');
  });

  it('throws_on_an_unrecognised_kind_rather_than_billing_it_as_text', () => {
    // 2026-09-14: this function decides the BILLED job_kind. The previous
    // `anything else -> text` fallback meant a caller passing the coarse DB
    // value 'media' (or any future unmapped kind) silently persisted a media
    // send as a TEXT job - charged at the text rate and sent down the text
    // transport branch. A groups pricing test hit exactly that and it read
    // as a fixture bug. Unmapped kinds now fail closed.
    expect(() => payloadKindFor('media')).toThrow(/Unknown message kind: media/);
    expect(() => payloadKindFor('reply')).toThrow(/Unknown message kind: reply/);
  });
});

describe('resolveMediaIdForEnqueue', () => {
  it('is_a_no_op_for_a_text_kind', async () => {
    const tx = fakeTxReturning(undefined);

    await expect(resolveMediaIdForEnqueue(tx, CLIENT_ID, 'text', {})).resolves.toBeUndefined();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('resolves_successfully_when_the_asset_exists_for_this_client_and_kind', async () => {
    const tx = fakeTxReturning({
      id: MEDIA_ID,
      kind: 'image',
      mime_type: 'image/jpeg',
      size_bytes: 100,
      file_name: null,
      created_at: '2026-09-14T10:00:00.000Z',
    });

    await expect(
      resolveMediaIdForEnqueue(tx, CLIENT_ID, 'image', { mediaId: MEDIA_ID }),
    ).resolves.toBeUndefined();
  });

  it('throws_media_asset_not_found_when_the_id_is_absent', async () => {
    const tx = fakeTxReturning(undefined);

    await expect(
      resolveMediaIdForEnqueue(tx, CLIENT_ID, 'image', { mediaId: MEDIA_ID }),
    ).rejects.toBeInstanceOf(MediaAssetNotFoundError);
  });

  it('throws_media_asset_not_found_when_the_stored_kind_does_not_match_the_requested_kind', async () => {
    const tx = fakeTxReturning({
      id: MEDIA_ID,
      kind: 'document',
      mime_type: 'application/pdf',
      size_bytes: 100,
      file_name: 'invoice.pdf',
      created_at: '2026-09-14T10:00:00.000Z',
    });

    await expect(
      resolveMediaIdForEnqueue(tx, CLIENT_ID, 'image', { mediaId: MEDIA_ID }),
    ).rejects.toBeInstanceOf(MediaAssetNotFoundError);
  });

  it('throws_media_asset_not_found_when_media_id_is_missing_from_the_payload', async () => {
    const tx = fakeTxReturning(undefined);

    await expect(resolveMediaIdForEnqueue(tx, CLIENT_ID, 'image', {})).rejects.toBeInstanceOf(
      MediaAssetNotFoundError,
    );
    expect(tx.query).not.toHaveBeenCalled();
  });
});
