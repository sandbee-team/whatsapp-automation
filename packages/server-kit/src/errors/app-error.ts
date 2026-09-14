import { ERROR_CODE_TO_HTTP_STATUS } from '@wp/contracts';
import type { AppErrorCode, CryptoErrorCode } from './codes.js';
import { toHttpErrorCode } from './codes.js';

export type AppErrorOptions = {
  /**
   * Whether this error's own `message` is safe to put in a client-facing
   * HTTP envelope. Defaults to `false` - an error is only exposed when a
   * throw site opts in explicitly. See `toHttpEnvelope` in `./to-http.js`.
   */
  expose?: boolean;
  cause?: unknown;
};

/**
 * The base application error. `httpStatus` is always derived from `code` via
 * `@wp/contracts`' `ERROR_CODE_TO_HTTP_STATUS` (through `toHttpErrorCode` for
 * internal codes) - it is never hand-set per throw site, so a code can never
 * drift from its status.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  readonly expose: boolean;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_CODE_TO_HTTP_STATUS[toHttpErrorCode(code)];
    this.expose = options.expose ?? false;
  }
}

/**
 * Thrown for any KEK/envelope-crypto failure (data-security design §4.5).
 * `message` and `toString()` are EXACTLY `<code>:<kekId>` - no plaintext, no
 * key material, no cause text, no stack. This is deliberately less detail
 * than a normal `Error` renders: the `kekId` is the only payload, and it is
 * never `expose`d to an HTTP client (see `toHttpEnvelope`) - it is for logs
 * only.
 */
export class CryptoError extends AppError {
  readonly kekId: string;

  constructor(code: CryptoErrorCode, kekId: string) {
    super(code, `${code}:${kekId}`, { expose: false });
    this.name = 'CryptoError';
    this.kekId = kekId;
  }

  override toString(): string {
    return this.message;
  }
}
