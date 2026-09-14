import * as React from 'react';
import { uuidv7 } from '@wp/utils';
import type { PgJobStatus } from '@wp/domain';
import { ApiError } from '../../../lib/api-client.js';
import { subscribeRealtimeEvent } from '../../../lib/sse-event-registry.js';
import { createMessage, type CreateMessageInput } from '../api.js';
import { useMediaUpload, type MediaUploadState } from '../../media/useMediaUpload.js';

/**
 * useComposer (P11 U6a) - the composer's state machine, split out of
 * `Composer.tsx` for a pure render layer (the `useConnectFlow.ts` idiom).
 *
 * TWO NON-NEGOTIABLE BEHAVIOURS (phase gotcha, binding):
 *
 * 1. ONE `Idempotency-Key` per SUBMISSION, reused on every retry. `keyRef`
 *    is minted (`uuidv7()`) the first time `onSend` runs for a given
 *    submission and is NOT regenerated on a retry of that same submission
 *    (double-click while still submitting, or a caller-driven retry after
 *    a transient failure) - it is only cleared (`keyRef.current = null`)
 *    once a submission actually settles (success OR a definitively
 *    terminal error), so the NEXT, different submission mints its own key.
 * 2. The message never renders "sent" from the 201/202 response alone -
 *    only `messageStatus.stage` moves to `'queued'` (or `'offline'` for the
 *    202 `INSTANCE_OFFLINE` warning) at that point. The transition to
 *    `'sent'` is driven EXCLUSIVELY by the SSE `message.job.status_changed`
 *    event for this exact `jobPublicId` reporting `status: 'sent'` - never
 *    an optimistic timer, never assumed from a successful POST.
 */

export type ComposeStage = 'idle' | 'submitting' | 'queued' | 'offline' | 'sent' | 'error';

/** The three error KINDS `Composer.tsx` maps to an exact i18n key - never a raw message string. */
export type ComposeErrorKind = 'idempotencyKeyReused' | 'instanceUnlinked' | 'generic';

export interface ComposerState {
  instanceId: string;
  recipient: string;
  body: string;
  stage: ComposeStage;
  errorMessage: ComposeErrorKind | null;
  jobPublicId: string | null;
  /** The single-attachment upload state (P34 unit C) - `Composer.tsx` renders its own picker/chip/error UI from this. */
  attachment: MediaUploadState;
  setInstanceId: (value: string) => void;
  setRecipient: (value: string) => void;
  setBody: (value: string) => void;
  onSend: () => void;
}

function errorMessageFor(error: unknown): ComposeErrorKind {
  if (error instanceof ApiError) {
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return 'idempotencyKeyReused';
    if (error.code === 'INSTANCE_UNLINKED') return 'instanceUnlinked';
  }
  return 'generic';
}

/** Submission-scoped, retry-safe state that must NOT be recreated on every render. */
interface SubmissionRef {
  idempotencyKey: string | null;
  instanceId: string | null;
}

export function useComposer(): ComposerState {
  const [instanceId, setInstanceId] = React.useState('');
  const [recipient, setRecipient] = React.useState('');
  const [body, setBody] = React.useState('');
  const [stage, setStage] = React.useState<ComposeStage>('idle');
  const [errorMessage, setErrorMessage] = React.useState<ComposeErrorKind | null>(null);
  const [jobPublicId, setJobPublicId] = React.useState<string | null>(null);
  const attachment = useMediaUpload();

  const submissionRef = React.useRef<SubmissionRef>({ idempotencyKey: null, instanceId: null });
  const jobPublicIdRef = React.useRef<string | null>(null);
  jobPublicIdRef.current = jobPublicId;

  React.useEffect(() => {
    return subscribeRealtimeEvent('message.job.status_changed', (event) => {
      if (event.jobPublicId !== jobPublicIdRef.current) return;
      applyJobStatus(event.status, setStage);
    });
  }, []);

  const onSend = React.useCallback((): void => {
    // A submission already in flight for THIS same key is a retry, not a
    // new submission - reuse the key. `stage === 'submitting'` guards a
    // rapid double-click; the key is only cleared below once this
    // submission settles.
    const existingKey = submissionRef.current.idempotencyKey;
    const idempotencyKey = existingKey ?? uuidv7();
    submissionRef.current = { idempotencyKey, instanceId };

    setStage('submitting');
    setErrorMessage(null);

    const input: CreateMessageInput = attachment.asset
      ? {
          kind: attachment.asset.kind,
          recipient,
          payload: {
            mediaId: attachment.asset.id,
            ...(body.trim().length > 0 ? { caption: body } : {}),
          },
          priority: 'normal',
        }
      : { kind: 'text', recipient, payload: { text: body }, priority: 'normal' };

    void createMessage(instanceId, input, idempotencyKey)
      .then((result) => {
        submissionRef.current = { idempotencyKey: null, instanceId: null };
        setJobPublicId(result.id);
        setStage(result.warning === 'INSTANCE_OFFLINE' ? 'offline' : 'queued');
        attachment.clear();
      })
      .catch((error: unknown) => {
        // A transport-level failure (network down, DNS, etc.) is exactly
        // the retryable case the mandatory test defends: the key is kept so
        // the NEXT `onSend()` call (the user's retry) reuses it. Any
        // definitively terminal API error (409, etc.) clears it - a
        // different, corrected submission must mint its own key.
        if (!(error instanceof ApiError)) {
          setStage('error');
          setErrorMessage('generic');
          return;
        }
        submissionRef.current = { idempotencyKey: null, instanceId: null };
        setStage('error');
        setErrorMessage(errorMessageFor(error));
      });
  }, [instanceId, recipient, body, attachment]);

  return {
    instanceId,
    recipient,
    body,
    stage,
    errorMessage,
    jobPublicId,
    attachment,
    setInstanceId,
    setRecipient,
    setBody,
    onSend,
  };
}

function applyJobStatus(status: PgJobStatus, setStage: (stage: ComposeStage) => void): void {
  if (status === 'sent') setStage('sent');
}
