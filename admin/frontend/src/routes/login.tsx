import { createFileRoute } from '@tanstack/react-router';
import { LoginForm } from '../features/auth/components/login-form.js';

export const Route = createFileRoute('/login')({
  component: LoginForm,
});
