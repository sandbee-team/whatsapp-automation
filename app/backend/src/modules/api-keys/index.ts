/**
 * modules/api-keys/index.ts (go-live U4) - the api-keys module's public
 * surface: generation/hashing (U2), request-auth-path verify/rate-limits
 * (U3), and the CRUD service/routes (U4). Another module imports ONLY this
 * file, never a sibling directly (layering rule - dependency-cruiser's
 * `no-deep-module-import`).
 */
export {
  generateApiKey,
  parseApiKey,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './generate-key.js';
export { hashApiKeySecret, verifyApiKeySecret, DUMMY_SECRET_HASH } from './hash.js';
export {
  verifyApiKey,
  type ApiKeyLookupRow,
  type ApiKeyPrincipal,
  type VerifyApiKeyDeps,
} from './verify.js';
export { consumeApiKeyRateLimit, type ApiKeyRateLimitInput } from './rate-limits.js';
export {
  insertApiKey,
  listApiKeys as listApiKeysRepo,
  revokeApiKey as revokeApiKeyRepo,
  touchLastUsedAt,
  lookupByKeyPrefix,
  shouldTouchLastUsedAt,
  wasRevoked,
  type ApiKeyRow,
  type ApiKeyLookupSqlRow,
} from './repo.js';
export {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  ApiKeyNotFoundError,
  type CreateApiKeyServiceInput,
  type CreateApiKeyServiceDeps,
  type CreateApiKeyResult,
  type RevokeApiKeyServiceInput,
  type RevokeApiKeyResult,
} from './service.js';
export { registerApiKeysRoutes, type ApiKeysRoutesDeps } from './routes.js';
