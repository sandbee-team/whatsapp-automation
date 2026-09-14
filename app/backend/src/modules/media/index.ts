/**
 * modules/media/index.ts (P34 U-upload, ADR 0052 accepted scope) - the
 * media module's public surface: upload service, repo, routes, retention
 * purge. Another module imports ONLY this file, never a sibling directly
 * (layering rule - same discipline `modules/api-keys/index.ts` documents).
 */
export {
  uploadMedia,
  UnsupportedMediaKindError,
  MediaTooLargeError,
  type UploadMediaInput,
  type UploadMediaDeps,
} from './media-upload.js';
export {
  insertOrGetMediaAsset,
  getMediaAssetById,
  resolveMediaAssetForDispatch,
  touchMediaAssetLastUsedAt,
  type MediaAssetRow,
  type MediaAssetForDispatch,
  type InsertOrGetMediaAssetInput,
} from './media.repo.js';
export { registerMediaRoutes, MediaNotFoundError, type MediaRoutesDeps } from './media.routes.js';
export {
  runOneMediaRetentionPurge,
  type MediaRetentionPurgeDeps,
  type MediaRetentionPurgeOutcome,
} from './retention-purge.js';
