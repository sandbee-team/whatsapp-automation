import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TotpEnrolPanel, TotpVerifyPanel } from '../features/auth/index.js';

const totpSearchSchema = z.object({
  mfaToken: z.string().optional(),
});

/**
 * `/totp` handles BOTH flows with one route: an `mfaToken` search param
 * means the caller arrived from `POST /v1/auth/login`'s `mfa_required`
 * result (verify flow); no `mfaToken` means an already-authenticated user
 * is enrolling TOTP for the first time (enrol flow).
 */
export const Route = createFileRoute('/totp')({
  validateSearch: totpSearchSchema,
  component: TotpRoute,
});

function TotpRoute(): React.JSX.Element {
  const { mfaToken } = Route.useSearch();
  return mfaToken ? <TotpVerifyPanel mfaToken={mfaToken} /> : <TotpEnrolPanel />;
}
