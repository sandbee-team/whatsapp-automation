import * as React from 'react';
import { ackFanoutItem, fetchPendingFanoutAcks, type PendingFanoutItem } from './api.js';

/**
 * useDuplicateFanoutAcks (P14 Unit U7, step 3) - owns everything
 * `DuplicateFanoutBanner.tsx` needs (same split idiom as `useComposer.ts`/
 * `Composer.tsx` and `useUnresolvedSends.ts`/`UnresolvedSendsPanel.tsx`).
 * Fetches the pending list on mount; `confirmItem` calls the ack endpoint
 * and OPTIMISTICALLY clears the confirmed item on success - a failed ack
 * leaves the item in place so the user can retry (never a silent drop).
 */

export type DuplicateFanoutStage = 'loading' | 'ready' | 'error';

export interface DuplicateFanoutItemState extends PendingFanoutItem {
  pending: boolean;
  /** Set after a failed confirm attempt for this exact item - cleared on the next successful confirm or a fresh list load. */
  failed: boolean;
}

export interface DuplicateFanoutAcksState {
  stage: DuplicateFanoutStage;
  items: DuplicateFanoutItemState[];
  confirmItem: (fingerprintHex: string) => void;
}

export function useDuplicateFanoutAcks(): DuplicateFanoutAcksState {
  const [stage, setStage] = React.useState<DuplicateFanoutStage>('loading');
  const [items, setItems] = React.useState<PendingFanoutItem[]>([]);
  const [pendingByFingerprint, setPendingByFingerprint] = React.useState<Record<string, boolean>>(
    {},
  );
  const [failedByFingerprint, setFailedByFingerprint] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    let cancelled = false;
    setStage('loading');

    void fetchPendingFanoutAcks()
      .then((result) => {
        if (cancelled) return;
        setItems(result);
        setStage('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStage('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const confirmItem = React.useCallback(
    (fingerprintHex: string): void => {
      // Double-click guard: an ack already in flight for this exact
      // fingerprint is a no-op, never a second request (same discipline as
      // useUnresolvedSends.ts's runAction).
      if (pendingByFingerprint[fingerprintHex]) return;
      const item = items.find((row) => row.fingerprintHex === fingerprintHex);
      if (!item) return;

      setPendingByFingerprint((prev) => ({ ...prev, [fingerprintHex]: true }));
      setFailedByFingerprint((prev) => ({ ...prev, [fingerprintHex]: false }));

      void ackFanoutItem(item)
        .then(() => {
          setItems((prev) => prev.filter((row) => row.fingerprintHex !== fingerprintHex));
        })
        .catch((error: unknown) => {
          void error;
          setFailedByFingerprint((prev) => ({ ...prev, [fingerprintHex]: true }));
        })
        .finally(() => {
          setPendingByFingerprint((prev) => {
            const next = { ...prev };
            delete next[fingerprintHex];
            return next;
          });
        });
    },
    [items, pendingByFingerprint],
  );

  const itemStates: DuplicateFanoutItemState[] = items.map((item) => ({
    ...item,
    pending: pendingByFingerprint[item.fingerprintHex] ?? false,
    failed: failedByFingerprint[item.fingerprintHex] ?? false,
  }));

  return { stage, items: itemStates, confirmItem };
}
