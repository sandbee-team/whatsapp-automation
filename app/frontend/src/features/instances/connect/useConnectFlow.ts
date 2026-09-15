import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from '@wp/ui';
import { ApiError, setAccessToken } from '../../../lib/api-client.js';
import { logout } from '../../auth/index.js';
import { createInstance, isNoFreeSlotError, link, online, park, refreshLink } from '../api.js';
import { useLinkStream, type LinkStreamState } from './useLinkStream.js';
import { connectErrorMessageKey, type ConnectErrorCopy } from './connect-error-copy.js';
import {
  mfaReasonForErrorCode,
  phoneFormSchema,
  type ConnectStage,
  type PhoneFormInput,
} from './connect-stage.js';

/**
 * useConnectFlow (P08 U7; 2026-09-08 bug fix added `connectError`) - all of
 * `ConnectSheet`'s stage transitions and API calls, split out of the
 * component itself so the component file stays a pure render (workspace
 * 300-line max-lines rule). Every 409 branch (`NO_FREE_SLOT`,
 * `REGISTERED_LIMIT_REACHED`, `INVALID_STATE`) is handled here, once, via
 * the shared `connectErrorMessageKey` helper, so the render layer never
 * re-derives error-code semantics and `onCreate`/`startLink`/`goOnline`
 * cannot drift apart on which codes they recognise.
 */
export interface UseConnectFlowOptions {
  open: boolean;
  realtimeState: 'connected' | 'disconnected';
  t: TFunction;
}

export interface ConnectFlow {
  stage: ConnectStage;
  label: string;
  setLabel: (label: string) => void;
  errorMessage: string | null;
  /** Set instead of `errorMessage` for codes that need a rich title/body/help block (currently `REGISTERED_LIMIT_REACHED`). */
  connectError: ConnectErrorCopy | null;
  isSubmitting: boolean;
  linkStream: LinkStreamState;
  activeInstanceId: string | null;
  phoneForm: ReturnType<typeof useForm<PhoneFormInput>>;
  onCreate: () => void;
  onChooseQr: (instanceId: string) => void;
  onChooseCode: (instanceId: string) => void;
  onSubmitPhone: (event?: React.BaseSyntheticEvent) => void;
  onRefresh: () => void;
  goOnline: (instanceId: string) => void;
  goPark: (instanceId: string) => void;
  parkHolderThenRetryOnline: (instanceId: string, holderInstanceId: string) => void;
  signInAgain: () => void;
}

export function useConnectFlow({ open, realtimeState, t }: UseConnectFlowOptions): ConnectFlow {
  const [stage, setStage] = React.useState<ConnectStage>({ name: 'create' });
  const [label, setLabel] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [connectError, setConnectError] = React.useState<ConnectErrorCopy | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // 'linking' MUST stay in this list: it is the post-`/online` waiting stage
  // (see `goOnline` below), and the effect that promotes it to 'connected'
  // depends entirely on `linkStream` still receiving `instance.health_changed`
  // events / `link-status` polls for this instance. Dropping 'linking' here
  // would silently stop the stream at the exact moment the user is waiting
  // for proof of a real link, stranding them on the waiting screen forever.
  const activeInstanceId =
    stage.name === 'method' ||
    stage.name === 'phone' ||
    stage.name === 'challenge' ||
    stage.name === 'linking'
      ? stage.instanceId
      : null;

  const linkStream = useLinkStream({ instanceId: activeInstanceId, isOpen: open, realtimeState });

  // FIX (2026-09-15 live bug): `POST /online` only flips `desired_state` to
  // 'online' (`instance-online-slot.repo.ts` setOnlineWithSlotCheck) - it
  // says nothing about whether the device is actually paired. Observed live:
  // a row with `link_state='pairing'`, `phone_e164=null`, `qr_attempts=4`
  // rendered "Connected - This number is linked and ready." because
  // `goOnline` treated the POST's 200 as proof of a link. The real proof is
  // `healthState === 'connected'`, which only ever arrives via
  // `useLinkStream` - either the `instance.health_changed` SSE event or its
  // `link-status` poll fallback. So `goOnline` now lands on the 'linking'
  // waiting stage, and only THIS effect - watching real link evidence - may
  // advance to 'connected'.
  React.useEffect(() => {
    if (stage.name !== 'linking') return;
    if (linkStream.healthState !== 'connected') return;
    setStage({ name: 'connected', maskedNumber: linkStream.maskedNumber });
  }, [stage, linkStream.healthState, linkStream.maskedNumber]);

  React.useEffect(() => {
    if (!open) {
      setStage({ name: 'create' });
      setLabel('');
      setErrorMessage(null);
      setConnectError(null);
    }
  }, [open]);

  const phoneForm = useForm<PhoneFormInput>({ resolver: zodResolver(phoneFormSchema) });

  const withSubmit = React.useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setIsSubmitting(true);
    setErrorMessage(null);
    setConnectError(null);
    try {
      await fn();
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  /**
   * Shared by `onCreate`/`startLink`: routes an MFA error code to the
   * `'mfa'` stage; otherwise defers to `connectErrorMessageKey` for the
   * codes `goOnline` also recognises (`REGISTERED_LIMIT_REACHED`,
   * `INVALID_STATE`), falling back to the generic error for anything else.
   */
  const handleCreateOrLinkError = (error: unknown): void => {
    const code = error instanceof ApiError ? error.code : null;
    const mfaReason = code ? mfaReasonForErrorCode(code) : null;
    if (mfaReason) {
      setStage({ name: 'mfa', reason: mfaReason });
      return;
    }
    const copy = code ? connectErrorMessageKey(code) : null;
    if (copy?.kind === 'limitOrNoPlan') {
      setConnectError(copy);
      return;
    }
    if (copy?.kind === 'plain') {
      setErrorMessage(t(copy.messageKey));
      return;
    }
    setErrorMessage(t('instances.connect.genericError'));
  };

  const onCreate = (): void => {
    void withSubmit(async () => {
      try {
        const result = await createInstance(label);
        setStage({ name: 'method', instanceId: result.id });
      } catch (error) {
        handleCreateOrLinkError(error);
      }
    });
  };

  const startLink = (instanceId: string, method: 'qr' | 'code', phone?: string): void => {
    void withSubmit(async () => {
      try {
        await link(instanceId, { method, phone });
        setStage({ name: 'challenge', instanceId, method });
      } catch (error) {
        handleCreateOrLinkError(error);
      }
    });
  };

  /** Same logout logic as the user menu (`user-menu.tsx#onLogout`) - never re-derived. */
  const signInAgain = (): void => {
    void (async () => {
      try {
        await logout();
      } finally {
        setAccessToken(null);
        queryClient.clear();
        await navigate({ to: '/login' });
      }
    })();
  };

  const onSubmitPhone = phoneForm.handleSubmit((values) => {
    if (stage.name !== 'phone') return;
    startLink(stage.instanceId, 'code', values.phone);
  });

  const onRefresh = (): void => {
    if (stage.name !== 'challenge') return;
    const { instanceId } = stage;
    void withSubmit(async () => {
      try {
        await refreshLink(instanceId);
      } catch {
        setErrorMessage(t('instances.connect.genericError'));
      }
    });
  };

  const goOnline = (instanceId: string): void => {
    void withSubmit(async () => {
      try {
        await online(instanceId);
        // Do NOT set 'connected' here - see the FIX comment above
        // `activeInstanceId`. This 200 only proves `desired_state` flipped;
        // 'linking' is left honest ("still pairing") until the effect above
        // sees real evidence.
        setStage({ name: 'linking', instanceId });
      } catch (error) {
        if (isNoFreeSlotError(error)) {
          setStage({ name: 'noFreeSlot', instanceId, holders: error.details.holders });
          return;
        }
        const code = error instanceof ApiError ? error.code : null;
        const copy = code ? connectErrorMessageKey(code) : null;
        if (copy?.kind === 'limitOrNoPlan') {
          setConnectError(copy);
          return;
        }
        if (copy?.kind === 'plain') {
          setErrorMessage(t(copy.messageKey));
          return;
        }
        setErrorMessage(t('instances.connect.genericError'));
      }
    });
  };

  const goPark = (instanceId: string): void => {
    void withSubmit(async () => {
      try {
        await park(instanceId);
        setStage({ name: 'parked' });
      } catch {
        setErrorMessage(t('instances.connect.genericError'));
      }
    });
  };

  const parkHolderThenRetryOnline = (instanceId: string, holderInstanceId: string): void => {
    void withSubmit(async () => {
      try {
        await park(holderInstanceId);
        await online(instanceId);
        // Same fix as `goOnline` above: the `/online` 200 here is proof of a
        // slot swap, not proof of a link - land on 'linking' and let real
        // link evidence (via `linkStream`) drive the 'connected' transition.
        setStage({ name: 'linking', instanceId });
      } catch {
        setErrorMessage(t('instances.connect.genericError'));
      }
    });
  };

  return {
    stage,
    label,
    setLabel,
    errorMessage,
    connectError,
    isSubmitting,
    linkStream,
    activeInstanceId,
    phoneForm,
    onCreate,
    onChooseQr: (instanceId) => startLink(instanceId, 'qr'),
    onChooseCode: (instanceId) => setStage({ name: 'phone', instanceId }),
    onSubmitPhone,
    onRefresh,
    goOnline,
    goPark,
    parkHolderThenRetryOnline,
    signInAgain,
  };
}
