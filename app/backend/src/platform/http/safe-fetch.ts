import { classifyHostnameLiteral, classifyResolvedAddress } from './ip-rules.js';
import { dispatchToResolvedIp, SafeFetchError } from './safe-fetch-dispatch.js';
import type { SafeFetchResponse } from './safe-fetch-dispatch.js';

// Re-exported for callers - the dispatcher unit imports SafeFetchError and
// SafeFetchResponse from THIS module (the public entry point); they are
// implemented in the sibling dispatch module purely to respect the
// 300-line file cap.
export { SafeFetchError };
export type { SafeFetchErrorCode, SafeFetchResponse } from './safe-fetch-dispatch.js';

/**
 * platform/http/safe-fetch.ts (P15 Unit U3) - the ONE function anything in
 * this codebase may use to dispatch an outbound webhook/callback request to
 * a client-supplied URL. Applies the SSRF guard at EVERY dispatch (design
 * §6.4 / blueprint [R-19s]) - never only at configuration time, because DNS
 * answers change between when a URL is saved and when it is dialled
 * (TOCTOU / "DNS rebinding"). Reference failure this exists to prevent:
 * evolution-api's SSRF check (`webhook.controller.ts:20-23`) was commented
 * out entirely.
 *
 * Contract, in dispatch order:
 *  1. scheme must be `https` - unconditionally, no opt-out (see
 *     `validateScheme`'s own doc comment for why an insecure-scheme escape
 *     hatch was removed rather than repaired);
 *  2. the RAW hostname text is classified as a possible numeric IPv4/IPv6
 *     literal (`classifyHostnameLiteral` - catches decimal/octal/hex forms
 *     `new URL()` may normalise away);
 *  3. WE resolve the hostname ourselves (`resolver`, default `dns.lookup`
 *     with `{ all: true }`) and classify EVERY answer - denied if ANY
 *     answer is denied;
 *  4. we connect to the FIRST allowed RESOLVED IP directly (never let the
 *     OS/socket layer re-resolve the hostname - that reopens the exact
 *     rebinding gap between check and connect), with `servername` and
 *     `checkServerIdentity` driven from the ORIGINAL hostname (so SNI and
 *     certificate validation are correct) and the `Host` header pinned to
 *     the original hostname[:port];
 *  5. redirects are never followed (`redirect: 'error'` semantics - a 3xx
 *     response is returned to the caller as a `SafeFetchError`, and no
 *     second request is ever issued);
 *  6. a 5s connect timeout and a 10s total timeout (both injectable);
 *  7. the response body is capped at 1 MB - the socket is destroyed and the
 *     partial body discarded the instant the cap is exceeded.
 *
 * Per-client concurrency is explicitly OUT of scope here - the caller
 * (dispatcher unit) owns that; `safeFetch` is a single one-shot request.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable in place of `dns.lookup({ all: true })` - the rebinding test stubs this. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /**
   * Explicit test/dev allow-list of `host:port` pairs exempt from address
   * denial (e.g. an ephemeral 127.0.0.1 fixture server). Never set in
   * production wiring - defaults to empty (deny loopback/private always).
   * MINOR FIX: gated on `process.env.NODE_ENV !== 'production'` INSIDE
   * `safeFetch` itself (never trusted from the caller alone) - even a caller
   * that mistakenly sets this in a production process can never actually
   * exempt an address once `NODE_ENV=production` is set.
   */
  devAllowedTargets?: string[];
  resolver?: Resolver;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Extra trusted CA certificates (PEM) - test fixtures only; never used in production wiring. */
  ca?: string | Buffer | Array<string | Buffer>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const dns = await import('node:dns');
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
}

/**
 * MINOR FIX: `devAllowedTargets` is gated on `process.env.NODE_ENV` HERE,
 * inside safeFetch itself - never trusted from the caller alone. A
 * production process (`NODE_ENV=production`) can never have any target
 * exempted from address denial, even if a caller mistakenly constructs a
 * `devAllowedTargets` list.
 */
function isDevAllowed(
  hostname: string,
  port: string,
  devAllowedTargets: string[] | undefined,
): boolean {
  if (devAllowedTargets === undefined) return false;
  if (process.env.NODE_ENV === 'production') return false;
  const target = `${hostname}:${port}`;
  return devAllowedTargets.includes(target) || devAllowedTargets.includes(hostname);
}

/** Resolves + classifies; throws SafeFetchError('address_denied'|'dns_resolution_failed') or returns the dialable IP. */
async function resolveAndValidate(
  url: URL,
  resolver: Resolver,
  devAllowedTargets: string[] | undefined,
): Promise<ResolvedAddress> {
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  const allowedByDev = isDevAllowed(hostname, url.port || '443', devAllowedTargets);

  if (!allowedByDev) {
    const literalClass = classifyHostnameLiteral(hostname);
    if (literalClass.denied) {
      throw new SafeFetchError(
        'address_denied',
        `hostname literal "${hostname}" denied: ${literalClass.reason ?? 'unknown'}`,
      );
    }
  }

  let answers: ResolvedAddress[];
  try {
    answers = await resolver(hostname);
  } catch (err) {
    throw new SafeFetchError('dns_resolution_failed', `DNS resolution failed for "${hostname}"`, {
      cause: err,
    });
  }
  if (answers.length === 0) {
    throw new SafeFetchError(
      'dns_resolution_failed',
      `DNS resolution returned no answers for "${hostname}"`,
    );
  }

  if (!allowedByDev) {
    for (const answer of answers) {
      const cls = classifyResolvedAddress(answer.address, answer.family);
      if (cls.denied) {
        throw new SafeFetchError(
          'address_denied',
          `resolved address ${answer.address} for "${hostname}" denied: ${cls.reason ?? 'unknown'}`,
        );
      }
    }
  }

  return answers[0]!;
}

/**
 * MINOR FIX: `allowInsecureScheme` was REMOVED (never repaired) - it only
 * ever widened `validateScheme`'s acceptance to `http:`, but
 * `dispatchToResolvedIp` (`safe-fetch-dispatch.ts`) always opens a `https`
 * (TLS) connection regardless, so passing it could only ever fail
 * confusingly (an `http:` URL "scheme-allowed" here would still be dialled
 * over TLS, immediately failing) - never a real bypass, never a working
 * option. It was never wired in production and had exactly one test use.
 * `safeFetch` now unconditionally requires `https:`.
 */
function validateScheme(url: URL): void {
  if (url.protocol === 'https:') return;
  throw new SafeFetchError('invalid_scheme', `scheme "${url.protocol}" is not allowed`);
}

/**
 * Dispatches ONE request to `urlString`, applying the full SSRF guard.
 * Never follows redirects. Caps the response body at `maxResponseBytes`
 * (default 1 MB), aborting the connection and discarding the partial body.
 */
export async function safeFetch(
  urlString: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const url = new URL(urlString);
  validateScheme(url);

  const resolver = options.resolver ?? defaultResolver;
  const resolved = await resolveAndValidate(url, resolver, options.devAllowedTargets);

  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const originalHostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const port = url.port !== '' ? Number(url.port) : 443;

  return dispatchToResolvedIp({
    resolvedIp: resolved.address,
    originalHostname,
    port,
    path: url.pathname + url.search,
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    connectTimeoutMs,
    totalTimeoutMs,
    maxResponseBytes,
    ca: options.ca,
  });
}
