import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT, useToast } from '@wp/ui';
import type { TFunction } from '@wp/ui';
import { requestGroupSync, setGroupSendEnabled, requestGroupLeave } from './api.js';
import { groupKeys } from './keys.js';
import { ApiError } from '../../lib/api-client.js';

type MessageKey = Parameters<TFunction>[0];

/**
 * useGroupListActions (P26b C1 fix round MAJOR-2/MAJOR-6) - owns every
 * mutation `GroupList` fires (sync/toggle-send/enable/leave), split out of
 * `group-list.tsx` to stay clear of the `max-lines: 300` cap (the
 * `useComposer.ts`/`Composer.tsx` split idiom).
 *
 * IDEMPOTENCY (binding, queue-engineering skill): each of the four action
 * sites keys its `Idempotency-Key` by `groupId + action` in `actionKeysRef`,
 * minted once per intent and reused on every retry of that SAME intent
 * (confirm dialogs stay open on failure) - same idiom as
 * `broadcast-detail.tsx`'s `actionKeyRef`. Cleared on success or a
 * definitively terminal 4xx `ApiError`; kept on a 5xx/transport failure so a
 * retry reuses it - never two real actions from one intent.
 *
 * Every failure path also raises a visible danger toast (previously
 * `onToggleSend`/`confirmLeave` had no `.catch` at all - a silent failure
 * plus an unhandled rejection - and `confirmEnable` silently closed the
 * dialog on any error other than `GROUP_NOT_SENDABLE`, as if it had
 * succeeded).
 */
export interface GroupListActionsState {
  busy: boolean;
  enableErrorMessage: string | undefined;
  syncRequestedAt: string | null;
  sawRateLimitedError: boolean;
  onSyncClick: () => void;
  onToggleSend: (groupId: string, nextEnabled: boolean) => void;
  /** Resolves `true` on success (caller closes its dialog), `false` on any failure (caller keeps it open). */
  confirmEnable: (groupId: string) => Promise<boolean>;
  /** Resolves `true` on success (caller closes its dialog), `false` on any failure (caller keeps it open). */
  confirmLeave: (groupId: string) => Promise<boolean>;
  clearEnableError: () => void;
}

function isTerminalClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

export function useGroupListActions(
  instanceId: string,
  onEnableRequested: (groupId: string) => void,
): GroupListActionsState {
  const t = useT();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [enableErrorMessage, setEnableErrorMessage] = React.useState<string | undefined>(undefined);
  const [syncRequestedAt, setSyncRequestedAt] = React.useState<string | null>(null);
  const [sawRateLimitedError, setSawRateLimitedError] = React.useState(false);

  const actionKeysRef = React.useRef<Map<string, string>>(new Map());

  const invalidateList = (): void => {
    void queryClient.invalidateQueries({ queryKey: groupKeys.list(instanceId) });
  };

  const keyFor = (mapKey: string): string => {
    const existing = actionKeysRef.current.get(mapKey);
    const key = existing ?? crypto.randomUUID();
    actionKeysRef.current.set(mapKey, key);
    return key;
  };

  const settleKey = (mapKey: string, error: unknown): void => {
    if (error === undefined || isTerminalClientError(error)) {
      actionKeysRef.current.delete(mapKey);
    }
  };

  const showActionErrorToast = (): void => {
    showToast({ tone: 'danger', title: t('groups.toast.actionError') });
  };

  const onSyncClick = (): void => {
    const key = keyFor(`${instanceId}:sync`);
    void requestGroupSync(instanceId, key)
      .then((result) => {
        settleKey(`${instanceId}:sync`, undefined);
        setSyncRequestedAt(result.requestedAt);
        setSawRateLimitedError(false);
        invalidateList();
      })
      .catch((error: unknown) => {
        settleKey(`${instanceId}:sync`, error);
        if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
          setSawRateLimitedError(true);
          return;
        }
        showActionErrorToast();
      });
  };

  const onToggleSend = (groupId: string, nextEnabled: boolean): void => {
    if (nextEnabled) {
      onEnableRequested(groupId);
      setEnableErrorMessage(undefined);
      return;
    }
    setBusy(true);
    const mapKey = `${groupId}:disable`;
    const key = keyFor(mapKey);
    void setGroupSendEnabled(groupId, false, key)
      .then(() => {
        settleKey(mapKey, undefined);
        invalidateList();
      })
      .catch((error: unknown) => {
        settleKey(mapKey, error);
        showActionErrorToast();
      })
      .finally(() => setBusy(false));
  };

  const confirmEnable = (groupId: string): Promise<boolean> => {
    setBusy(true);
    setEnableErrorMessage(undefined);
    const mapKey = `${groupId}:enable`;
    const key = keyFor(mapKey);
    return setGroupSendEnabled(groupId, true, key)
      .then(() => {
        settleKey(mapKey, undefined);
        invalidateList();
        return true;
      })
      .catch((error: unknown) => {
        settleKey(mapKey, error);
        if (error instanceof ApiError && error.code === 'GROUP_NOT_SENDABLE') {
          const details = error.details as
            { reason?: string; trackedDevicesEnabledTotal?: number; max?: number } | undefined;
          const reason = (details?.reason ?? 'NOT_SEND_ENABLED') as string;
          setEnableErrorMessage(
            t(`groups.reason.${reason}` as MessageKey, {
              total: details?.trackedDevicesEnabledTotal ?? 0,
              max: details?.max ?? 0,
            }),
          );
          return false;
        }
        // Any other error keeps the dialog open (never a silent success-like
        // close) with a visible generic message, and also raises the same
        // danger toast every other mutation failure does.
        setEnableErrorMessage(t('groups.toast.actionError'));
        showActionErrorToast();
        return false;
      })
      .finally(() => setBusy(false));
  };

  const confirmLeave = (groupId: string): Promise<boolean> => {
    setBusy(true);
    const mapKey = `${groupId}:leave`;
    const key = keyFor(mapKey);
    return requestGroupLeave(groupId, key)
      .then(() => {
        settleKey(mapKey, undefined);
        invalidateList();
        return true;
      })
      .catch((error: unknown) => {
        settleKey(mapKey, error);
        showActionErrorToast();
        return false;
      })
      .finally(() => setBusy(false));
  };

  return {
    busy,
    enableErrorMessage,
    syncRequestedAt,
    sawRateLimitedError,
    onSyncClick,
    onToggleSend,
    confirmEnable,
    confirmLeave,
    clearEnableError: () => setEnableErrorMessage(undefined),
  };
}
