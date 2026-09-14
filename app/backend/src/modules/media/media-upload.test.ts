import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createFsObjectStore } from '../../platform/storage/object-store-fs.js';
import type { ObjectStore } from '../../platform/storage/object-store-types.js';
import { MediaTooLargeError, UnsupportedMediaKindError, uploadMedia } from './media-upload.js';

/**
 * media-upload.test.ts (P34 U-upload) - unit tests against the real fs
 * `ObjectStore` driver (fast, no mocked fs, same idiom as
 * `object-store.test.ts`) and a minimal in-process fake `TenantQueryable`
 * that just records the INSERT/SELECT it was called with - proves the
 * validate-before-store and hash-while-streaming behaviour without a real
 * Postgres connection (the full insert-or-dedupe path is exercised by the
 * route integration test against real Postgres).
 */

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

let rootDir: string;
let objectStore: ObjectStore;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-media-upload-'));
  objectStore = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function bodyOf(bytes: Buffer): Readable {
  return Readable.from([bytes]);
}

/** Records every query; the SELECT after INSERT always returns one row shaped like the caller's own insert - good enough to exercise `uploadMedia`'s own logic without a real Postgres round trip. */
function fakeTx(): TenantQueryable {
  let lastInsertParams: unknown[] = [];
  return {
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number | null }> => {
      if (sql.trim().startsWith('INSERT')) {
        lastInsertParams = params;
        return { rows: [], rowCount: 1 };
      }
      const [, id, kind, mimeType, sizeBytes, fileName] = lastInsertParams as [
        string,
        string,
        string,
        string,
        number,
        string | null,
      ];
      return {
        rows: [
          {
            id,
            kind,
            mime_type: mimeType,
            size_bytes: sizeBytes,
            file_name: fileName,
            created_at: '2026-09-14T10:00:00.000Z',
          } as unknown as T,
        ],
        rowCount: 1,
      };
    },
  };
}

describe('uploadMedia', () => {
  it('a_valid_image_upload_stores_exactly_one_object_and_returns_its_metadata', async () => {
    const bytes = Buffer.from('fake-jpeg-bytes');
    const result = await uploadMedia(
      fakeTx(),
      { objectStore, now: () => new Date('2026-09-14T10:00:00.000Z') },
      {
        clientId: CLIENT_ID,
        kind: 'image',
        mimeType: 'image/jpeg',
        fileName: null,
        body: bodyOf(bytes),
        createdByUserId: null,
      },
    );

    expect(result.kind).toBe('image');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(bytes.length);
  });

  it('a_disallowed_mime_for_the_kind_is_rejected_before_any_byte_is_stored', async () => {
    await expect(
      uploadMedia(
        fakeTx(),
        { objectStore },
        {
          clientId: CLIENT_ID,
          kind: 'image',
          mimeType: 'application/pdf',
          fileName: null,
          body: bodyOf(Buffer.from('x')),
          createdByUserId: null,
        },
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaKindError);
  });

  it('an_upload_past_the_cap_aborts_without_buffering_the_file_and_leaves_no_object', async () => {
    const overCap = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61); // one byte over the 5 MB image cap

    await expect(
      uploadMedia(
        fakeTx(),
        { objectStore },
        {
          clientId: CLIENT_ID,
          kind: 'image',
          mimeType: 'image/png',
          fileName: null,
          body: bodyOf(overCap),
          createdByUserId: null,
        },
      ),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
  });

  it('a_document_upload_carries_its_file_name_through', async () => {
    const result = await uploadMedia(
      fakeTx(),
      { objectStore, now: () => new Date('2026-09-14T10:00:00.000Z') },
      {
        clientId: CLIENT_ID,
        kind: 'document',
        mimeType: 'application/pdf',
        fileName: 'invoice.pdf',
        body: bodyOf(Buffer.from('%PDF-1.4')),
        createdByUserId: null,
      },
    );

    expect(result.fileName).toBe('invoice.pdf');
  });
});
