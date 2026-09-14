/**
 * @wp/server-kit/tenant - TenantContext + runInTenant() (AsyncLocalStorage).
 * Filled in P01 step: missing context throws, it never defaults to "all
 * tenants". The SET LOCAL app.client_id half belongs to withTenant/TenantDb
 * in P02, not here.
 */
export {
  currentTenant,
  runInTenant,
  TenantContextMissingError,
  type TenantContext,
} from './context.js';
