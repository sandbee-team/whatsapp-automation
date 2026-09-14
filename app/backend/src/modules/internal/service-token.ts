/**
 * service-token.ts (P28 Unit U2, step 3) - thin re-export shim. The real
 * implementation MOVED to `@wp/server-kit/auth` (P19 Unit U5's HMAC
 * service-token + IPv4 CIDR primitives are now a shared package, not a
 * backend-local module - see `packages/server-kit/src/auth/service-token.ts`
 * and `.../cidr.ts` for the byte-for-byte moved code and its own doc
 * comments). Kept as a re-export so this file's existing import path and its
 * sibling `service-token.test.ts` stay green unchanged.
 */
export {
  signServiceToken,
  buildServiceTokenHeader,
  verifyServiceToken,
  isIpAllowed,
  type VerifyServiceTokenInput,
} from '@wp/server-kit/auth';
