/** features/clients/keys.ts (P28 Unit U6, step 9) - query key factory for the client surface. */
export const clientKeys = {
  all: ['admin', 'clients'] as const,
  list: (filters: { status?: string; q?: string }) =>
    ['admin', 'clients', 'list', filters] as const,
  detail: (id: string) => ['admin', 'clients', 'detail', id] as const,
};
