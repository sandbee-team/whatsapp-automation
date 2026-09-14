/** features/instances/keys.ts (P28 Unit U6, step 9) - query key factory for the fleet instance surface. */
export const instanceKeys = {
  list: (filters: { healthState?: string; clientId?: string }) =>
    ['admin', 'instances', 'list', filters] as const,
};
