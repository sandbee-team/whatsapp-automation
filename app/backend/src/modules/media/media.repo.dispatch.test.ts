import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { resolveMediaAssetForDispatch, touchMediaAssetLastUsedAt } from './media.repo.js';

/**
 * media.repo.dispatch.test.ts (P34 Unit B, ADR 0052 accepted scope) - the
 * two dispatch-facing accessors `engine/queue/dispatch.ts` needs:
 * `resolveMediaAssetForDispatch` (the only reader that ever sees
 * `storageKey`) and `touchMediaAssetLastUsedAt` (the `last_used_at` stamp).
 * A minimal fake `TenantQueryable` - no real Postgres needed to prove the
 * shape/row-mapping/null-on-miss behaviour.
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const MEDIA_ID = '22222222-2222-2222-2222-222222222222';

function fakeTxReturning(row: Record<string, unknown> | undefined): TenantQueryable {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  };
}

describe('resolveMediaAssetForDispatch', () => {
  it('returns_the_storage_key_alongside_the_tenant_facing_metadata', async () => {
    const tx = fakeTxReturning({
      id: MEDIA_ID,
      kind: 'image',
      mime_type: 'image/jpeg',
      size_bytes: 12345,
      file_name: null,
      storage_key: 'clients/11111111-1111-1111-1111-111111111111/media/2026/09/abc.jpg',
      created_at: '2026-09-14T10:00:00.000Z',
    });

    const result = await resolveMediaAssetForDispatch(tx, CLIENT_ID, MEDIA_ID);

    expect(result).toEqual({
      id: MEDIA_ID,
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 12345,
      fileName: null,
      createdAt: '2026-09-14T10:00:00.000Z',
      storageKey: 'clients/11111111-1111-1111-1111-111111111111/media/2026/09/abc.jpg',
    });
  });

  it('returns_null_for_a_foreign_or_absent_media_id', async () => {
    const tx = fakeTxReturning(undefined);

    const result = await resolveMediaAssetForDispatch(tx, CLIENT_ID, MEDIA_ID);

    expect(result).toBeNull();
  });
});

describe('touchMediaAssetLastUsedAt', () => {
  it('runs_the_scoped_update_with_client_id_and_id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const tx: TenantQueryable = { query };

    await touchMediaAssetLastUsedAt(tx, CLIENT_ID, MEDIA_ID);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE media_assets'), [
      CLIENT_ID,
      MEDIA_ID,
    ]);
  });
});
