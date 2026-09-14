import * as React from 'react';
import { assertAllowedMedia, MEDIA_CAPS_BYTES, type MediaKind } from '@wp/domain';
import type { MediaAsset } from './api.js';
import { uploadMedia } from './api.js';

/**
 * useMediaUpload (P34 unit C, ADR 0052 accepted scope) - the composer's
 * single-attachment upload state machine. Validates a picked `File` against
 * the SAME `@wp/domain` constants the backend enforces (`assertAllowedMedia`)
 * BEFORE ever calling the network, so an over-cap or wrong-MIME file never
 * reaches `POST /v1/media` - the mandatory test defends exactly this ("no
 * upload request is made"). Only one attachment may be in flight/attached at
 * once (composer scope item 1: "Only ONE attachment per message"), enforced
 * by this hook always replacing, never queuing, the previous attempt.
 */
export type MediaUploadErrorKind = 'tooLarge' | 'unsupportedType' | 'uploadFailed';

export type MediaUploadStage = 'idle' | 'uploading' | 'ready' | 'error';

export interface MediaUploadState {
  stage: MediaUploadStage;
  asset: MediaAsset | null;
  file: File | null;
  errorKind: MediaUploadErrorKind | null;
  /** Picks a file for `kind`, validates it client-side, then uploads it. Replaces any prior attachment. */
  pickFile: (kind: MediaKind, file: File) => void;
  /** Clears the current attachment (picked, uploading, or uploaded) - returns the composer to plain text. */
  clear: () => void;
}

function kindForMimeType(mimeType: string): MediaKind | null {
  if (mimeType.startsWith('image/')) return 'image';
  return 'document';
}

export function useMediaUpload(): MediaUploadState {
  const [stage, setStage] = React.useState<MediaUploadStage>('idle');
  const [asset, setAsset] = React.useState<MediaAsset | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [errorKind, setErrorKind] = React.useState<MediaUploadErrorKind | null>(null);

  // Guards a stale upload's resolution from clobbering a NEWER pick/clear -
  // the same "only the latest submission's result counts" shape
  // `useComposer.ts`'s idempotency-key ref uses for its own retry safety.
  const generationRef = React.useRef(0);

  const clear = React.useCallback((): void => {
    generationRef.current += 1;
    setStage('idle');
    setAsset(null);
    setFile(null);
    setErrorKind(null);
  }, []);

  const pickFile = React.useCallback((kind: MediaKind, pickedFile: File): void => {
    generationRef.current += 1;
    const generation = generationRef.current;

    const resolvedKind = kindForMimeType(pickedFile.type) ?? kind;
    const check = assertAllowedMedia({
      kind: resolvedKind,
      mimeType: pickedFile.type,
      sizeBytes: pickedFile.size,
    });

    if (!check.ok) {
      setFile(pickedFile);
      setAsset(null);
      setStage('error');
      setErrorKind(check.error.code === 'PAYLOAD_TOO_LARGE' ? 'tooLarge' : 'unsupportedType');
      return;
    }

    setFile(pickedFile);
    setAsset(null);
    setErrorKind(null);
    setStage('uploading');

    void uploadMedia(resolvedKind, pickedFile)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setAsset(result);
        setStage('ready');
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setStage('error');
        setErrorKind('uploadFailed');
      });
  }, []);

  return { stage, asset, file, errorKind, pickFile, clear };
}

export { MEDIA_CAPS_BYTES };
