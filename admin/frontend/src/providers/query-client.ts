import { QueryClient } from '@tanstack/react-query';

/**
 * The single TanStack Query client for the staff console (mirrors
 * app/frontend/src/providers/query-client.ts). No retry-storm defaults: one
 * retry only, matching `apiFetch`'s own one-shot refresh-then-retry
 * behaviour on 401 (see lib/api-client.ts).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
