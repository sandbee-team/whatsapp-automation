import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { acquireRealtimeConnection, type RealtimeConnectionState } from './sse.js';

/**
 * useRealtimeConnectionState (P26b U2) - a standalone hook for surfaces
 * outside `AppShell` (the onboarding wizard's connect step is rendered
 * before `_authed`'s `AppShell` ever mounts) that still need to know the
 * realtime connection state to pass into `useConnectFlow`'s poll-fallback
 * decision. Shares the same ref-counted singleton connection as `AppShell`
 * (`lib/sse.ts`), so mounting both never opens two independent streams.
 */
export function useRealtimeConnectionState(): RealtimeConnectionState {
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<RealtimeConnectionState>('reconnecting');

  React.useEffect(() => {
    const handle = acquireRealtimeConnection({
      queryClient,
      onStateChange: setState,
    });
    return () => {
      handle.release();
    };
  }, [queryClient]);

  return state;
}
