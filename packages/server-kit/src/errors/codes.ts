import type { ErrorCode } from '@wp/contracts';

/**
 * Internal error codes - codes raised deep inside `@wp/server-kit` (tenant
 * context, crypto, config) that are NOT themselves `@wp/contracts` HTTP
 * codes. Every one of these renders to HTTP as `INTERNAL` (never leaks an
 * internals-specific code to a client) via `INTERNAL_ERROR_CODE_TO_HTTP_CODE`
 * below - the table other code in this package reads from, mirroring how
 * `@wp/contracts`' `ERROR_CODE_TO_HTTP_STATUS` is the one status table.
 */
export const INTERNAL_ERROR_CODES = [
  'TENANT_CONTEXT_MISSING',
  'CRYPTO_KEY_UNAVAILABLE',
  'CRYPTO_DECRYPT_FAILED',
  'CRYPTO_ENCRYPT_FAILED',
  'CRYPTO_PURPOSE_MISMATCH',
  'CRYPTO_KEY_RING_INVALID',
  'CONFIG_INVALID',
] as const;

export type InternalErrorCode = (typeof INTERNAL_ERROR_CODES)[number];

/** The `CRYPTO_*` subset of `InternalErrorCode` - the codes `CryptoError` accepts. */
export type CryptoErrorCode = Extract<InternalErrorCode, `CRYPTO_${string}`>;

/** Every code `AppError` can carry: either an `@wp/contracts` HTTP code, or one of ours. */
export type AppErrorCode = ErrorCode | InternalErrorCode;

/**
 * Exhaustive over `InternalErrorCode` by construction (a `Record` over a
 * union type fails to compile if a member is missing) - every internal code
 * renders as `INTERNAL`; none is HTTP-specific.
 */
export const INTERNAL_ERROR_CODE_TO_HTTP_CODE: Record<InternalErrorCode, ErrorCode> = {
  TENANT_CONTEXT_MISSING: 'INTERNAL',
  CRYPTO_KEY_UNAVAILABLE: 'INTERNAL',
  CRYPTO_DECRYPT_FAILED: 'INTERNAL',
  CRYPTO_ENCRYPT_FAILED: 'INTERNAL',
  CRYPTO_PURPOSE_MISMATCH: 'INTERNAL',
  CRYPTO_KEY_RING_INVALID: 'INTERNAL',
  CONFIG_INVALID: 'INTERNAL',
};

export function isInternalErrorCode(code: string): code is InternalErrorCode {
  return (INTERNAL_ERROR_CODES as readonly string[]).includes(code);
}

/** Maps any `AppErrorCode` to the `@wp/contracts` code it renders as over HTTP. */
export function toHttpErrorCode(code: AppErrorCode): ErrorCode {
  if (isInternalErrorCode(code)) {
    return INTERNAL_ERROR_CODE_TO_HTTP_CODE[code];
  }
  return code;
}
