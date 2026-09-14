import { createFileRoute } from '@tanstack/react-router';
import { InstanceDetailPage } from '../../features/instances/components/instance-detail-page.js';

/**
 * `/instances/$id` (P26b U3) - the per-number detail route: `PageHeader`
 * with breadcrumbs (Numbers > label), status chips, pause/resume/reconnect/
 * why actions, and Overview/Health/Queue tabs. No `beforeLoad` guard beyond
 * the parent `_authed`/`instances.index` gates already in force - reaching
 * `/instances/$id` at all already implies onboarding is `connect_whatsapp`
 * or later.
 */
export const Route = createFileRoute('/_authed/instances/$id')({
  component: InstanceDetailPage,
});
