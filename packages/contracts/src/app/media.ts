import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * media.ts (P34 U-upload, ADR 0052 "Founder acceptance 2026-09-14 -
 * ACCEPTED SCOPE") - wire shapes for `POST /v1/media` (multipart upload)
 * and `GET /v1/media/:id` (metadata only). Follows the
 * `contact-imports.ts#uploadContactImportContract` shape (`.output()` only,
 * no `.input()`, since the body is a raw multipart stream never validated
 * by zod) with ONE deliberate difference: `uploadImportOutputSchema`
 * returns `storageKey` in its response; this contract's output schema
 * NEVER includes a storage key (this unit's own dispatch instruction,
 * ADR 0052 accepted item 2's "upload-then-send" boundary - the key is an
 * internal implementation detail, the `mediaId` is the only handle a
 * caller ever holds).
 */

export const mediaKindSchema = z.enum(['image', 'document']);
export type MediaKindContract = z.infer<typeof mediaKindSchema>;

/** The metadata shape returned by BOTH the upload response and the metadata-read response - kept as one schema so the two can never drift. */
export const mediaAssetSchema = z
  .object({
    id: z.uuid(),
    kind: mediaKindSchema,
    mimeType: z.string(),
    sizeBytes: z.number().int().positive(),
    fileName: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MediaAssetContract = z.infer<typeof mediaAssetSchema>;

export const uploadMediaOutputSchema = successEnvelope(mediaAssetSchema);
export type UploadMediaOutput = z.infer<typeof uploadMediaOutputSchema>;

export const uploadMediaContract = oc
  .route({ method: 'POST', path: '/v1/media' })
  .output(uploadMediaOutputSchema);

/** Path-param schema for `GET /v1/media/:id` - `.strict()` so an unplanned extra param field is rejected too. */
export const mediaIdParamSchema = z.object({ id: z.uuid() }).strict();
export type MediaIdParam = z.infer<typeof mediaIdParamSchema>;

export const getMediaOutputSchema = successEnvelope(mediaAssetSchema);
export type GetMediaOutput = z.infer<typeof getMediaOutputSchema>;

export const getMediaContract = oc
  .route({ method: 'GET', path: '/v1/media/{id}' })
  .output(getMediaOutputSchema);

export const mediaContract = {
  upload: uploadMediaContract,
  get: getMediaContract,
} as const;
