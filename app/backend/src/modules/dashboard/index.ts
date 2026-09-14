/**
 * modules/dashboard - the ONLY public surface of this module (layering rule
 * §3.2, enforced by dependency-cruiser's no-deep-module-import). P17 carried
 * item: `GET /v1/dashboard/summary`.
 */
export { registerDashboardRoutes, type DashboardRoutesDeps } from './summary.routes.js';
export {
  readDashboardSummary,
  type DashboardServiceRedis,
  type ReadDashboardSummaryInput,
} from './summary.service.js';
