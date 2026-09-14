import * as React from 'react';
import { Sheet, useT } from '@wp/ui';
import { useConnectFlow } from './useConnectFlow.js';
import { ConnectSheetBody } from './ConnectSheetBody.js';

/**
 * ConnectSheet (P08 U7) - the Connect flow: create-or-pick instance ->
 * method choice (QR | 8-digit code) -> live challenge panel -> connected /
 * parked states. All state and API calls live in `useConnectFlow`; this
 * component only wires the `Sheet` chrome and hands the resulting
 * `ConnectFlow` down to `ConnectSheetBody`'s stage-conditional render tree
 * (split across three files to stay under the workspace's 300-line
 * max-lines lint rule).
 */
export interface ConnectSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Realtime connection state - passed through to `useLinkStream`'s poll fallback. */
  realtimeState?: 'connected' | 'disconnected';
}

export function ConnectSheet({
  open,
  onOpenChange,
  realtimeState = 'disconnected',
}: ConnectSheetProps): React.JSX.Element {
  const t = useT();
  const flow = useConnectFlow({ open, realtimeState, t });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('instances.connect.title')}
      description={t('instances.connect.description')}
      closeLabel={t('common.close')}
    >
      <ConnectSheetBody flow={flow} />
    </Sheet>
  );
}
