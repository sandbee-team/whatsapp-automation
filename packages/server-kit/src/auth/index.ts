/**
 * @wp/server-kit/auth - shared staff/internal-surface auth primitives: the
 * HMAC service-token sign/build/verify functions and the IPv4 CIDR
 * allow-list matcher (P28 Unit U2, step 3; moved from
 * `app/backend/src/modules/internal/service-token.ts`, P19 Unit U5).
 */
export {
  signServiceToken,
  buildServiceTokenHeader,
  verifyServiceToken,
  type VerifyServiceTokenInput,
} from './service-token.js';
export { isIpAllowed } from './cidr.js';
