import { createFileRoute } from '@tanstack/react-router';
import { LoginForm } from '../features/auth/index.js';

export const Route = createFileRoute('/login')({
  component: LoginForm,
});
