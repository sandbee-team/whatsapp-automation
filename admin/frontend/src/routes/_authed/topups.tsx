import { createFileRoute } from '@tanstack/react-router';
import { TopupsQueue } from '../../features/topups/components/topups-queue.js';

export const Route = createFileRoute('/_authed/topups')({
  component: TopupsQueue,
});
