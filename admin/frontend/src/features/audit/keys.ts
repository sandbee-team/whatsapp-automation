/** features/audit/keys.ts (P28 Unit U6, step 9) - query key factory for the staff audit log. */
export const auditKeys = {
  list: (filters: { clientId?: string; staffId?: string; action?: string }) =>
    ['admin', 'audit', 'list', filters] as const,
};
