import * as React from 'react';
import { uuidv7 } from '@wp/utils';
import { useT, useToast } from '@wp/ui';
import { ApiError } from '../../lib/api-client.js';
import {
  discardUnresolved,
  fetchUnresolvedSends,
  retryUnresolved,
  type UnresolvedSendRow,
  type UnresolvedSendsSource,
} from './api.js';

/**
 * useUnresolvedSends (P12 U6a) - owns everything `UnresolvedSendsPanel.tsx`
 * needs, exactly like `useComposer.ts`/`Composer.tsx`'s split. Per-instance:
 * loads the row list via `fetchUnresolvedSends` (see that module's NO LIST
 * ROUTE doc - `source` tells the panel whether the list is genuinely known
 * or honestly unavailable), and exposes `retryRow`/`discardRow` actions.
 *
 * DOUBLE-CLICK GUARD (phase gotcha, binding): each row keeps its OWN
 * `Idempotency-Key`, minted with `uuidv7()` the first time either action is
 * invoked for that row and reused for as long as an action is in flight for
 * it (`pendingAction` tracked per `jobPublicId`) - the SAME "one key per
 * submission, cleared only on settle" idiom as `useComposer.ts#onSend`.
 * `pendingAction` ALSO drives `UnresolvedSendsPanel.tsx`'s per-button
 * `loading`/`disabled` state, so a rapid second click on either button
 * while the first request is still in flight is a no-op at the guard
 * below, never a second HTTP request with a second key.
 */

export type UnresolvedRowAction = 'retry' | 'discard';

export interface UnresolvedRowState extends UnresolvedSendRow {
  pendingAction: UnresolvedRowAction | null;
}

export type UnresolvedSendsStage = 'loading' | 'ready' | 'error';

export interface UnresolvedSendsState {
  stage: UnresolvedSendsStage;
  source: UnresolvedSendsSource | null;
  rows: UnresolvedRowState[];
  count: number;
  retryRow: (jobPublicId: string) => void;
  discardRow: (jobPublicId: string) => void;
}

interface RowKeyEntry {
  action: UnresolvedRowAction;
  idempotencyKey: string;
}

export function useUnresolvedSends(instanceId: string): UnresolvedSendsState {
  const t = useT();
  const { showToast } = useToast();
  const [stage, setStage] = React.useState<UnresolvedSendsStage>('loading');
  const [source, setSource] = React.useState<UnresolvedSendsSource | null>(null);
  const [rows, setRows] = React.useState<UnresolvedSendRow[]>([]);
  const [pendingByJob, setPendingByJob] = React.useState<Record<string, UnresolvedRowAction>>({});

  // Row-scoped, retry-safe key storage that must not be recreated on every
  // render - same shape as `useComposer.ts`'s `submissionRef`.
  const keysRef = React.useRef<Map<string, RowKeyEntry>>(new Map());

  React.useEffect(() => {
    let cancelled = false;
    setStage('loading');

    void fetchUnresolvedSends(instanceId)
      .then((result) => {
        if (cancelled) return;
        setSource(result.source);
        setRows(result.rows);
        setStage('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStage('error');
      });

    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  const runAction = React.useCallback(
    (jobPublicId: string, action: UnresolvedRowAction): void => {
      // Guard: an action already in flight for this exact row is a
      // double-click (or a second distinct button while the first is still
      // pending) - both are no-ops here, never a second request/key.
      if (pendingByJob[jobPublicId]) return;

      const existing = keysRef.current.get(jobPublicId);
      const idempotencyKey =
        existing && existing.action === action ? existing.idempotencyKey : uuidv7();
      keysRef.current.set(jobPublicId, { action, idempotencyKey });

      setPendingByJob((prev) => ({ ...prev, [jobPublicId]: action }));

      const call = action === 'retry' ? retryUnresolved : discardUnresolved;

      void call(jobPublicId, idempotencyKey)
        .then(() => {
          keysRef.current.delete(jobPublicId);
          setRows((prev) => prev.filter((row) => row.jobPublicId !== jobPublicId));
          showToast({
            tone: 'success',
            title: t(
              action === 'retry'
                ? 'unresolved.toast.retrySuccess'
                : 'unresolved.toast.discardSuccess',
            ),
          });
        })
        .catch((error: unknown) => {
          // A definitively terminal 4xx clears the key so a corrected retry
          // mints its own; a 5xx or transport failure keeps it so the
          // user's manual retry click reuses the same key (never two real
          // actions from one intent).
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            keysRef.current.delete(jobPublicId);
          }
          showToast({ tone: 'danger', title: t('unresolved.toast.actionError') });
        })
        .finally(() => {
          setPendingByJob((prev) => {
            const next = { ...prev };
            delete next[jobPublicId];
            return next;
          });
        });
    },
    [pendingByJob],
  );

  const retryRow = React.useCallback(
    (jobPublicId: string) => runAction(jobPublicId, 'retry'),
    [runAction],
  );
  const discardRow = React.useCallback(
    (jobPublicId: string) => runAction(jobPublicId, 'discard'),
    [runAction],
  );

  const rowStates: UnresolvedRowState[] = rows.map((row) => ({
    ...row,
    pendingAction: pendingByJob[row.jobPublicId] ?? null,
  }));

  return {
    stage,
    source,
    rows: rowStates,
    count: rowStates.length,
    retryRow,
    discardRow,
  };
}
