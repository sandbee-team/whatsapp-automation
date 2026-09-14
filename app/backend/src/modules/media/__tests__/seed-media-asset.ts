import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { createPool } from '@wp/db';
import { createTenantDb } from '@wp/db';
import type {
  ObjectContentType,
  ObjectStore,
} from '../../../platform/storage/object-store-types.js';
import { insertOrGetMediaAsset } from '../media.repo.js';

/**
 * seed-media-asset.ts (P34, 2026-09-14) - the ONE way a test gets a usable
 * `mediaId`.
 *
 * Why it is shared rather than copied: before P34, a test that wanted a media
 * job simply set `payloadKind: 'media'` with an invented payload like
 * `{ mediaUrl: '...' }`. That shape never reached WhatsApp (the adapter sent
 * it as text - the 2026-09-14 billing defect), and now that dispatch really
 * resolves a `mediaId` against `media_assets`, such a fixture makes dispatch
 * DEFER instead of send, which reads as a mysterious failure in a test that
 * is not about media at all. Two suites hit exactly that. Any test that needs
 * a media job seeds a REAL asset through this helper.
 */
export async function seedMediaAsset(
  pool: ReturnType<typeof createPool>,
  objectStore: ObjectStore,
  clientId: string,
  // `mimeType` is the STORE's own narrowed union, not a bare string - the
  // object store only accepts a type it actually allows, so a fixture
  // inventing an unsupported MIME fails at compile time rather than at run
  // time inside an unrelated suite.
  opts: {
    kind?: 'image' | 'document';
    mimeType?: ObjectContentType;
    fileName?: string | null;
  } = {},
): Promise<string> {
  const kind = opts.kind ?? 'image';
  const mimeType = opts.mimeType ?? (kind === 'image' ? 'image/jpeg' : 'application/pdf');
  const id = randomUUID();

  const stored = await objectStore.put({
    clientId,
    kind: 'media',
    body: Readable.from([Buffer.from(`seeded-${kind}-bytes-${id}`)]),
    contentType: mimeType,
    maxBytes: 5 * 1024 * 1024,
    now: new Date(),
    id,
  });

  const tenantDb = createTenantDb(pool);
  await tenantDb.withTenant(clientId, (tx) =>
    insertOrGetMediaAsset(tx, {
      clientId,
      id,
      kind,
      mimeType,
      sizeBytes: stored.bytes,
      fileName: opts.fileName ?? null,
      storageKey: stored.key,
      // A per-asset unique digest - these fixtures never test dedupe, and a
      // shared constant would trip the `(client_id, sha256)` unique index the
      // second time a suite seeds one.
      sha256: Buffer.from(id.replace(/-/g, ''), 'hex'),
      createdByUserId: null,
    }),
  );

  return id;
}
