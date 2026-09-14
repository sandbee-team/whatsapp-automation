/** features/topups/keys.ts (P28 Unit U6, step 9) - query key factory for the top-up queue. */
export const topupKeys = {
  list: (status: string) => ['admin', 'topups', 'list', status] as const,
};
