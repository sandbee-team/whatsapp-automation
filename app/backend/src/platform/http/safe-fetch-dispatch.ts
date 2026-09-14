import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { PeerCertificate, TLSSocket } from 'node:tls';

/**
 * platform/http/safe-fetch-dispatch.ts (P15 Unit U3, sibling split of
 * safe-fetch.ts to respect the 300-line cap) - the low-level single-socket
 * HTTPS dispatch primitive. `safe-fetch.ts` owns the SSRF policy decision
 * (scheme/hostname/address checks); this module owns nothing but "given an
 * already-validated resolved IP and original hostname, open exactly one
 * TLS connection to that IP, with SNI/certificate identity pinned to the
 * original hostname, never follow redirects, and cap the response body".
 *
 * `rejectUnauthorized` is NEVER overridden here (Node's secure default -
 * `true` - is left untouched), so `checkServerIdentity` always runs against
 * `servername` before `secureConnect` fires; see
 * `scripts/check-no-insecure-tls.ts`, which fails the build if any file in
 * this tree ever disables that verification.
 */

export type SafeFetchErrorCode =
  | 'invalid_scheme'
  | 'address_denied'
  | 'dns_resolution_failed'
  | 'redirect_not_followed'
  | 'connect_timeout'
  | 'total_timeout'
  | 'response_too_large'
  | 'tls_error'
  | 'network_error';

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

export interface SafeFetchResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface DispatchParams {
  resolvedIp: string;
  originalHostname: string;
  port: number;
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
  ca?: string | Buffer | Array<string | Buffer>;
}

/**
 * Opens exactly one TLS connection to `resolvedIp` (never re-resolving
 * `originalHostname` - that would reopen the DNS-rebinding gap the caller
 * already closed) and returns the buffered response, capped at
 * `maxResponseBytes`. Redirects (3xx) are reported as a
 * `redirect_not_followed` error, never followed.
 */
export function dispatchToResolvedIp(params: DispatchParams): Promise<SafeFetchResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      req.destroy();
      reject(
        err instanceof SafeFetchError
          ? err
          : new SafeFetchError('network_error', String(err), { cause: err }),
      );
    };

    const hostHeader =
      params.port === 443
        ? params.originalHostname
        : `${params.originalHostname}:${String(params.port)}`;

    const req: ClientRequest = httpsRequest({
      host: params.resolvedIp,
      port: params.port,
      path: params.path,
      method: params.method,
      // `servername` drives SNI; Node's default (never overridden)
      // `checkServerIdentity` then validates the cert's SAN against THIS
      // hostname - never the IP actually dialled. [R-19s] verbatim.
      servername: params.originalHostname,
      // MINOR FIX: `Host` is pinned AFTER the caller-headers spread so it
      // can never be overridden by a caller-supplied `Host` entry - this
      // header drives many origin servers' own virtual-host routing
      // independent of the IP actually dialled, exactly the SSRF-relevant
      // property the DNS-rebinding guard exists to control.
      headers: {
        ...params.headers,
        Host: hostHeader,
      },
      timeout: params.connectTimeoutMs,
      ca: params.ca,
    });

    const totalTimer = setTimeout(() => {
      settleReject(
        new SafeFetchError(
          'total_timeout',
          `total timeout exceeded (${String(params.totalTimeoutMs)}ms)`,
        ),
      );
    }, params.totalTimeoutMs);

    req.once('timeout', () => {
      settleReject(
        new SafeFetchError(
          'connect_timeout',
          `connect timeout exceeded (${String(params.connectTimeoutMs)}ms)`,
        ),
      );
    });

    req.once('error', (err) => {
      settleReject(new SafeFetchError('network_error', err.message, { cause: err }));
    });

    req.once('socket', (socket) => {
      socket.once('secureConnect', () => {
        const tlsSocket = socket as TLSSocket;
        const cert: PeerCertificate = tlsSocket.getPeerCertificate();
        // Identity was already verified before 'secureConnect' fired
        // (rejectUnauthorized defaults true, never overridden) - failure
        // surfaces via the request's own 'error' event instead.
        void cert;
      });
    });

    req.once('response', (res: IncomingMessage) => {
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        settleReject(
          new SafeFetchError(
            'redirect_not_followed',
            `redirect (${String(res.statusCode)}) not followed`,
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > params.maxResponseBytes) {
          aborted = true;
          res.destroy();
          settleReject(
            new SafeFetchError(
              'response_too_large',
              `response exceeded ${String(params.maxResponseBytes)} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });

      res.once('end', () => {
        if (aborted || settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });

      res.once('error', (err) => {
        settleReject(new SafeFetchError('network_error', err.message, { cause: err }));
      });
    });

    if (params.body !== undefined) {
      req.end(params.body);
    } else {
      req.end();
    }
  });
}
