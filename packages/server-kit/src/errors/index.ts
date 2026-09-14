/**
 * @wp/server-kit/errors - the AppError hierarchy + HTTP envelope mapper.
 */
export {
  INTERNAL_ERROR_CODES,
  INTERNAL_ERROR_CODE_TO_HTTP_CODE,
  isInternalErrorCode,
  toHttpErrorCode,
  type InternalErrorCode,
  type CryptoErrorCode,
  type AppErrorCode,
} from './codes.js';

export { AppError, CryptoError, type AppErrorOptions } from './app-error.js';

export { toHttpEnvelope, type HttpErrorResponse } from './to-http.js';
