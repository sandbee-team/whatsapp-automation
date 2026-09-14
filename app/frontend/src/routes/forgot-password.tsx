import { createFileRoute } from '@tanstack/react-router';
import { ForgotPasswordForm } from '../features/auth/index.js';

/**
 * `/forgot-password` (P28 Unit U7) - PUBLIC: reached from the login page by
 * a visitor who cannot sign in, so no `_authed` guard and no session fetch.
 */
export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordForm,
});
