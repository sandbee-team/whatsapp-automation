import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { VerifyEmailPanel } from '../features/auth/index.js';

const verifyEmailSearchSchema = z.object({
  token: z.string().optional(),
});

export const Route = createFileRoute('/verify-email')({
  validateSearch: verifyEmailSearchSchema,
  component: VerifyEmailRoute,
});

function VerifyEmailRoute(): React.JSX.Element {
  const { token } = Route.useSearch();
  return <VerifyEmailPanel token={token} />;
}
