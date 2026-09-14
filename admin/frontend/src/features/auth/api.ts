import type { z } from 'zod';
import { staffLoginInputSchema, staffSessionDataSchema, staffMeDataSchema } from '@wp/contracts';
import { adminFetch, setAccessToken } from '../../lib/api-client.js';

/**
 * features/auth/api.ts (P28 Unit U6, step 9) - `/admin/v1/auth/*`. Every
 * response type is inferred FROM the imported `@wp/contracts` schemas, same
 * idiom as `app/frontend/src/features/broadcasts/api.ts`.
 */
export type StaffLoginInput = z.infer<typeof staffLoginInputSchema>;
export type StaffSessionData = z.infer<typeof staffSessionDataSchema>;
export type StaffMeData = z.infer<typeof staffMeDataSchema>;

export async function staffLogin(input: StaffLoginInput): Promise<StaffSessionData> {
  const result = await adminFetch<StaffSessionData>('/admin/v1/auth/login', {
    method: 'POST',
    body: input,
  });
  setAccessToken(result.accessToken);
  return result;
}

export function me(): Promise<StaffMeData> {
  return adminFetch<StaffMeData>('/admin/v1/auth/me');
}

export async function staffLogout(): Promise<void> {
  await adminFetch<{ ok: true }>('/admin/v1/auth/logout', { method: 'POST' });
  setAccessToken(null);
}
