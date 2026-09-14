import { createFileRoute } from '@tanstack/react-router';
import { SignupForm } from '../features/auth/index.js';

export const Route = createFileRoute('/signup')({
  component: SignupForm,
});
