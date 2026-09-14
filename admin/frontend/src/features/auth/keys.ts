/** features/auth/keys.ts (P28 Unit U6, step 9) - query key factory for the staff session. */
export const authKeys = {
  me: () => ['admin', 'auth', 'me'] as const,
};
