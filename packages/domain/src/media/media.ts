/**
 * media.ts (P34 U-upload, ADR 0052 "Founder acceptance 2026-09-14 - ACCEPTED
 * SCOPE") - pure media constants and validation for the outbound media
 * pipeline. This is the ACCEPTED slice ONLY: two kinds, `image` and
 * `document` - video/audio are DESIGNED, NOT APPROVED (ADR 0052 body S1) and
 * must not be added here without a new acceptance. No Node builtins (this
 * package ships to a browser panel - `@wp/domain`'s own module doc).
 *
 * Caps are the ACCEPTED figures, not the ADR body's proposal and not the
 * founder's 2026-09-14 "all five kinds" answer superseded the same day: image
 * 5 MB / document 20 MB (acceptance item 3 - the 100 MB document figure from
 * the earlier same-day answer is explicitly NOT adopted, since there is no
 * per-client storage quota).
 */

export const MEDIA_KINDS = ['image', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_CAPS_BYTES: Readonly<Record<MediaKind, number>> = {
  image: 5 * 1024 * 1024,
  document: 20 * 1024 * 1024,
};

/**
 * MIME allow-list per kind. `document` carries PDF plus the common office
 * formats an SMB catalogue/invoice/price-list is realistically shared as
 * (Word/Excel, old and OOXML) plus plain text/CSV - the same set the pre-
 * existing import upload already trusts for `text/csv`.
 */
export const MEDIA_MIME_ALLOW_LIST: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
  ],
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** The file extension for a MIME type in `MEDIA_MIME_ALLOW_LIST` - throws for anything outside it (the object-store key builder must never guess). */
export function extensionForMime(mimeType: string): string {
  const ext = EXTENSION_BY_MIME[mimeType];
  if (!ext) {
    throw new TypeError(`no known extension for MIME type: ${mimeType}`);
  }
  return ext;
}

export interface AssertAllowedMediaInput {
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
}

export type AllowedMediaError =
  | { code: 'PAYLOAD_TOO_LARGE'; maxBytes: number }
  | { code: 'UNSUPPORTED_MEDIA_TYPE'; mimeType: string; kind: MediaKind };

export type AssertAllowedMediaResult = { ok: true } | { ok: false; error: AllowedMediaError };

/**
 * Validates `input` against `MEDIA_MIME_ALLOW_LIST`/`MEDIA_CAPS_BYTES` for
 * its `kind`, returning a TYPED error (never a boolean) so the caller can
 * map it to the right HTTP status/response shape without re-deriving which
 * check failed.
 */
export function assertAllowedMedia(input: AssertAllowedMediaInput): AssertAllowedMediaResult {
  const maxBytes = MEDIA_CAPS_BYTES[input.kind];
  if (input.sizeBytes > maxBytes) {
    return { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', maxBytes } };
  }

  const allowList = MEDIA_MIME_ALLOW_LIST[input.kind];
  if (!allowList.includes(input.mimeType)) {
    return {
      ok: false,
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', mimeType: input.mimeType, kind: input.kind },
    };
  }

  return { ok: true };
}
