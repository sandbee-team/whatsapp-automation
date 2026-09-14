import * as React from 'react';
import { Button, Card, CardBody, Textarea, useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { AccountPicker } from './AccountPicker.js';
import { RecipientPicker } from './RecipientPicker.js';
import { MessagePreview } from './MessagePreview.js';
import { MessageStatus } from './MessageStatus.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { useComposer } from './useComposer.js';

const BODY_MAX_LENGTH = 4096;

/** Maps `useComposer`'s error-kind union to its exact i18n key - no string concatenation/cast. */
const ERROR_MESSAGE_KEYS = {
  idempotencyKeyReused: 'messages.compose.errorIdempotencyKeyReused',
  instanceUnlinked: 'messages.compose.errorInstanceUnlinked',
  generic: 'messages.compose.errorGeneric',
} as const;

/**
 * Composer (P11 U6a; P26b U4 restyle) - `PageHeader` + a two-column layout on
 * `lg` (form left, live preview right; stacked on mobile). Every handler/
 * state field still comes from `useComposer` (pure render layer, unchanged
 * contract - idempotency-key reuse and the SSE-only "sent" transition are
 * entirely owned there). The "From number" field is now a real `Select`
 * (`AccountPicker`, fed by the shared `useInstanceList`) with a hidden,
 * still-functional `compose-account-input` underneath for existing tests; the
 * recipient field gained a contacts typeahead (`RecipientPicker`) that only
 * ever fills the same free-typed value.
 */
export function Composer(): React.JSX.Element {
  const t = useT();
  const composer = useComposer();

  const hasAttachment = composer.attachment.stage === 'ready' && composer.attachment.asset !== null;
  const uploadInProgress = composer.attachment.stage === 'uploading';

  const canSend =
    composer.instanceId.trim().length > 0 &&
    composer.recipient.trim().length > 0 &&
    (hasAttachment || composer.body.trim().length > 0) &&
    composer.stage !== 'submitting' &&
    !uploadInProgress;

  return (
    <div data-testid="composer" className="flex flex-col gap-6">
      <PageHeader title={t('messages.compose.title')} />

      {composer.errorMessage ? (
        <p role="alert" className="text-sm font-ui text-danger">
          {t(ERROR_MESSAGE_KEYS[composer.errorMessage])}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardBody className="flex flex-col gap-4">
            <AccountPicker value={composer.instanceId} onValueChange={composer.setInstanceId} />

            <RecipientPicker value={composer.recipient} onValueChange={composer.setRecipient} />

            <AttachmentPicker
              attachment={composer.attachment}
              disabled={composer.stage === 'submitting'}
            />

            <Textarea
              label={
                hasAttachment ? t('messages.compose.captionLabel') : t('messages.compose.bodyLabel')
              }
              placeholder={t('messages.compose.bodyPlaceholder')}
              data-testid="compose-body-input"
              value={composer.body}
              maxLength={BODY_MAX_LENGTH}
              counterLabel={(count, max) => t('messages.compose.charCount', { count, max })}
              onChange={(event) => composer.setBody(event.target.value)}
            />

            {uploadInProgress ? (
              <p data-testid="compose-upload-in-progress" className="text-sm font-ui text-muted">
                {t('messages.compose.attachment.errorUploadInProgress')}
              </p>
            ) : null}

            <Button
              type="button"
              data-testid="compose-send-button"
              disabled={!canSend}
              loading={composer.stage === 'submitting'}
              loadingLabel={t('common.loading')}
              onClick={composer.onSend}
            >
              {t('messages.compose.sendButton')}
            </Button>

            <MessageStatus stage={composer.stage} />
          </CardBody>
        </Card>

        <MessagePreview body={composer.body} />
      </div>
    </div>
  );
}
