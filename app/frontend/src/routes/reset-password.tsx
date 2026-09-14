import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ToastProvider, useT } from '@wp/ui';
import { ResetPasswordForm } from '../features/auth/index.js';

/**
 * `/reset-password?token=` (P28 Unit U7) - PUBLIC, same as `/verify-email`:
 * the visitor arrives from a one-time email link with no session at all.
 * `ToastProvider` is mounted here rather than in `_authed` (which this route
 * is deliberately NOT a child of) because the success toast fires on a
 * public page; `dismissLabel` comes from `@wp/i18n`'s `common.close`.
 */
const resetPasswordSearchSchema = z.object({
  token: z.string().optional(),
});

export const Route = createFileRoute('/reset-password')({
  validateSearch: resetPasswordSearchSchema,
  component: ResetPasswordRoute,
});

function ResetPasswordRoute(): React.JSX.Element {
  const t = useT();
  const { token } = Route.useSearch();
  return (
    <ToastProvider dismissLabel={t('common.close')}>
      <ResetPasswordForm token={token} />
    </ToastProvider>
  );
}
