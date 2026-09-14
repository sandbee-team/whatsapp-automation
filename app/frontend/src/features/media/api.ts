import type { z } from 'zod';
import { mediaAssetSchema } from '@wp/contracts';
import type { MediaKind } from '@wp/domain';
import { apiFetchRaw } from '../../lib/api-client.js';

/**
 * features/media/api.ts (P34 unit C, ADR 0052 accepted scope) - the ONE
 * client call for the outbound media pipeline the composer needs:
 * `POST /v1/media?kind=...&fileName=...`. Same raw-body idiom as
 * `features/contacts/api.ts#uploadContactImportFile` - the request body IS
 * the file (no multipart wrapper), `Content-Type` carries the file's exact
 * MIME, and `kind`/`fileName` ride as query params (`media.routes.ts`'s
 * `uploadQuerySchema`, read before writing this client per this unit's own
 * dispatch instruction). The response type is inferred FROM
 * `@wp/contracts#mediaAssetSchema`, never hand-typed.
 */
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export async function uploadMedia(kind: MediaKind, file: File): Promise<MediaAsset> {
  const params = new URLSearchParams({ kind });
  if (file.name) params.set('fileName', file.name);

  const response = await apiFetchRaw(`/v1/media?${params.toString()}`, {
    method: 'POST',
    body: file,
    contentType: file.type,
    accept: 'application/json',
  });
  const json = (await response.json()) as { data: MediaAsset };
  return json.data;
}
