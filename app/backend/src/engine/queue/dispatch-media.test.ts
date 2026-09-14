import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { MediaDispatchDeferError, resolveTransportMediaPayload } from './dispatch-media.js';

/**
 * dispatch-media.test.ts (P34 Unit B, ADR 0052 accepted scope) -
 * `resolveTransportMediaPayload`'s three outcomes: a resolved image, a
 * resolved document (with a fallback file name when the stored row has
 * none), and the two DEFER-worthy failure modes (asset not found / object
 * store unavailable). No real Postgres or object store - fakes throughout.
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const MEDIA_ID = '22222222-2222-2222-2222-222222222222';
const RECIPIENT_JID = '911234567890@s.whatsapp.net';

function fakeTxReturning(row: Record<string, unknown> | undefined): TenantQueryable {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  };
}

function imageAssetRow(): Record<string, unknown> {
  return {
    id: MEDIA_ID,
    kind: 'image',
    mime_type: 'image/jpeg',
    size_bytes: 1000,
    file_name: null,
    storage_key: 'clients/11111111-1111-1111-1111-111111111111/media/2026/09/abc.jpg',
    created_at: '2026-09-14T10:00:00.000Z',
  };
}

describe('resolveTransportMediaPayload', () => {
  it('resolves_an_image_with_the_stream_and_caption', async () => {
    const tx = fakeTxReturning(imageAssetRow());
    const stream = Readable.from(['bytes']);
    const objectStore = { getStream: vi.fn().mockResolvedValue(stream) };

    const result = await resolveTransportMediaPayload(tx, objectStore as never, {
      clientId: CLIENT_ID,
      recipientJid: RECIPIENT_JID,
      payload: { kind: 'image', mediaId: MEDIA_ID, caption: 'hello' },
    });

    expect(result).toEqual({
      to: RECIPIENT_JID,
      kind: 'image',
      stream,
      caption: 'hello',
    });
    expect(objectStore.getStream).toHaveBeenCalledWith(
      'clients/11111111-1111-1111-1111-111111111111/media/2026/09/abc.jpg',
    );
  });

  it('resolves_a_document_with_the_stored_mime_type_and_file_name', async () => {
    const tx = fakeTxReturning({
      id: MEDIA_ID,
      kind: 'document',
      mime_type: 'application/pdf',
      size_bytes: 1000,
      file_name: 'invoice.pdf',
      storage_key: 'clients/11111111-1111-1111-1111-111111111111/media/2026/09/def.pdf',
      created_at: '2026-09-14T10:00:00.000Z',
    });
    const stream = Readable.from(['bytes']);
    const objectStore = { getStream: vi.fn().mockResolvedValue(stream) };

    const result = await resolveTransportMediaPayload(tx, objectStore as never, {
      clientId: CLIENT_ID,
      recipientJid: RECIPIENT_JID,
      payload: { kind: 'document', mediaId: MEDIA_ID },
    });

    expect(result).toEqual({
      to: RECIPIENT_JID,
      kind: 'document',
      stream,
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      caption: undefined,
    });
  });

  it('throws_media_dispatch_defer_error_when_the_asset_is_missing', async () => {
    const tx = fakeTxReturning(undefined);
    const objectStore = { getStream: vi.fn() };

    await expect(
      resolveTransportMediaPayload(tx, objectStore as never, {
        clientId: CLIENT_ID,
        recipientJid: RECIPIENT_JID,
        payload: { kind: 'image', mediaId: MEDIA_ID },
      }),
    ).rejects.toBeInstanceOf(MediaDispatchDeferError);
    expect(objectStore.getStream).not.toHaveBeenCalled();
  });

  it('throws_media_dispatch_defer_error_when_the_object_store_fails', async () => {
    const tx = fakeTxReturning(imageAssetRow());
    const objectStore = { getStream: vi.fn().mockRejectedValue(new Error('storage down')) };

    await expect(
      resolveTransportMediaPayload(tx, objectStore as never, {
        clientId: CLIENT_ID,
        recipientJid: RECIPIENT_JID,
        payload: { kind: 'image', mediaId: MEDIA_ID },
      }),
    ).rejects.toBeInstanceOf(MediaDispatchDeferError);
  });
});
