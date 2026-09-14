import * as React from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button, Spinner, useT } from '@wp/ui';
import { MEDIA_CAPS_BYTES, MEDIA_MIME_ALLOW_LIST, type MediaKind } from '@wp/domain';
import type { MediaUploadState } from '../../media/useMediaUpload.js';

/**
 * AttachmentPicker (P34 unit C, ADR 0052 accepted scope) - the composer's
 * file-picker + pending/ready chip, split out of `Composer.tsx` for the
 * `MessageStatus.tsx` max-lines idiom. Renders from `useMediaUpload`'s state
 * ONLY - never re-derives upload progress/errors itself. An image gets a
 * local `URL.createObjectURL` thumbnail (the accepted scope's explicit "do
 * NOT fetch bytes back from the server" rule - no download route exists); a
 * document gets an icon + file name.
 */
export interface AttachmentPickerProps {
  attachment: MediaUploadState;
  disabled?: boolean;
}

const ACCEPT_ATTRIBUTE = [...MEDIA_MIME_ALLOW_LIST.image, ...MEDIA_MIME_ALLOW_LIST.document].join(
  ',',
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function kindFromMimeType(mimeType: string): MediaKind {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

const ERROR_KEYS = {
  tooLarge: 'messages.compose.attachment.errorTooLarge',
  unsupportedType: 'messages.compose.attachment.errorUnsupportedType',
  uploadFailed: 'messages.compose.attachment.errorUploadFailed',
} as const;

export function AttachmentPicker({
  attachment,
  disabled = false,
}: AttachmentPickerProps): React.JSX.Element {
  const t = useT();
  const inputId = React.useId();
  const objectUrlRef = React.useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (attachment.file && attachment.file.type.startsWith('image/')) {
      const url = URL.createObjectURL(attachment.file);
      objectUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      setPreviewUrl(null);
    }
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [attachment.file]);

  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    attachment.pickFile(kindFromMimeType(file.type), file);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label
          htmlFor={inputId}
          className="text-sm font-medium font-ui text-fg"
          data-testid="attachment-label"
        >
          {t('messages.compose.attachment.label')}
        </label>
      </div>
      <input
        id={inputId}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        data-testid="attachment-input"
        disabled={disabled || attachment.stage === 'uploading'}
        onChange={onChange}
      />
      <p className="text-xs font-ui text-muted">
        {t('messages.compose.attachment.caps', {
          imageMb: (MEDIA_CAPS_BYTES.image / (1024 * 1024)).toFixed(0),
          documentMb: (MEDIA_CAPS_BYTES.document / (1024 * 1024)).toFixed(0),
        })}
      </p>

      {attachment.stage === 'uploading' && attachment.file ? (
        <div
          data-testid="attachment-pending"
          className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2"
        >
          <Spinner size="sm" aria-label={t('messages.compose.attachment.uploading')} />
          <span className="text-sm font-ui text-fg">{attachment.file.name}</span>
        </div>
      ) : null}

      {attachment.stage === 'ready' && attachment.asset ? (
        <div
          data-testid="attachment-chip"
          className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-3 py-2"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              className="h-8 w-8 shrink-0 rounded object-cover"
              data-testid="attachment-thumbnail"
            />
          ) : (
            <FileText aria-hidden="true" size={20} className="shrink-0 text-muted" />
          )}
          <span className="flex-1 truncate text-sm font-ui text-fg">
            {attachment.asset.fileName ?? attachment.file?.name}
          </span>
          <span className="text-xs font-ui text-muted">
            {formatBytes(attachment.asset.sizeBytes)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="attachment-remove-button"
            aria-label={t('messages.compose.attachment.remove')}
            onClick={attachment.clear}
          >
            <X aria-hidden="true" size={16} />
          </Button>
        </div>
      ) : null}

      {attachment.stage === 'error' && attachment.errorKind ? (
        <p role="alert" data-testid="attachment-error" className="text-sm font-ui text-danger">
          {t(ERROR_KEYS[attachment.errorKind])}
        </p>
      ) : null}

      {attachment.stage === 'idle' ? (
        <p className="flex items-center gap-1 text-xs font-ui text-muted">
          <Paperclip aria-hidden="true" size={14} />
          {t('messages.compose.attachment.hint')}
        </p>
      ) : null}
    </div>
  );
}
