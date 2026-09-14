/**
 * media-exports.ts (P34 U-upload, ADR 0052 accepted scope) - sibling barrel
 * split for the outbound media constants/validator, same reasoning as
 * `obs-exports.ts`/`enums-exports.ts`: keeps `index.ts` itself under the
 * `max-lines: 300` cap while still surfacing everything through the single
 * `@wp/domain` package entry point.
 */
export {
  MEDIA_KINDS,
  type MediaKind,
  MEDIA_CAPS_BYTES,
  MEDIA_MIME_ALLOW_LIST,
  extensionForMime,
  type AssertAllowedMediaInput,
  type AllowedMediaError,
  type AssertAllowedMediaResult,
  assertAllowedMedia,
} from './media.js';
