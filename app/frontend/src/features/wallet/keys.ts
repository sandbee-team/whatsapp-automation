/**
 * features/wallet/keys.ts (P19 Unit U5, step 7/9) - query key factory only,
 * same shape-matters idiom as `features/webhooks/keys.ts`.
 */
export const walletKeys = {
  summary: () => ['wallet', 'summary'] as const,
  topupRequests: () => ['wallet', 'topup-requests'] as const,
  queueStatus: () => ['wallet', 'queue-status'] as const,
};
