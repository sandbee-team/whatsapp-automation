/**
 * media-exports.ts (P34 U-upload, ADR 0052 accepted scope) - the media
 * upload/metadata contract re-export block split out of `index.ts` (same
 * "never trim a contract comment to make room, split instead" idiom as
 * `contacts-exports.ts`/`broadcasts-exports.ts`).
 */
export {
  mediaKindSchema,
  type MediaKindContract,
  mediaAssetSchema,
  type MediaAssetContract,
  uploadMediaOutputSchema,
  type UploadMediaOutput,
  uploadMediaContract,
  mediaIdParamSchema,
  type MediaIdParam,
  getMediaOutputSchema,
  type GetMediaOutput,
  getMediaContract,
  mediaContract,
} from './media.js';
