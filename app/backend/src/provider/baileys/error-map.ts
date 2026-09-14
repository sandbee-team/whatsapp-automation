import type { SendErrorClass } from '../provider.types.js';

/**
 * error-map.ts (P11 Unit U2, step 4) - Baileys/Boom send failure ->
 * `SendErrorClass`. Sibling to `disconnect-map.ts` and built the SAME way:
 * DATA, not branching code - a lookup table plus a fail-safe default. No
 * reconnect logic, no timers, no socket references live here.
 *
 * `classifySendError` is a pure function of a Boom-shaped error (or any
 * error-like value): unrecognised input -> `'unknown'`, NEVER
 * `'transient'` (core invariant 2, fail-safe - `@wp/domain`'s `classify()`
 * already hard-pauses on `'unknown'`, so an unmapped provider error can
 * never be silently retried).
 *
 * Shapes verified against the PINNED `baileys@7.0.0-rc14` source
 * (`node_modules/.pnpm/baileys@7.0.0-rc14.../lib`), not assumed:
 *   - `Boom.output.statusCode` is always a number (Boom defaults to 500 if
 *     the thrower did not pass one) - `@hapi/boom`'s own `Options.statusCode`.
 *   - `DisconnectReason.connectionClosed` (428) / `.connectionLost` (408) /
 *     `.timedOut` (408, same numeric code - Baileys collapses these, see
 *     `disconnect-map.ts`'s own comment) are thrown as `new Boom(...,
 *     {statusCode: DisconnectReason.X})` from `Socket/socket.js` on a
 *     dropped/timed-out connection - mapped to `not_connected` here (a send
 *     attempted against a socket that just closed, not a slow-but-live one).
 *   - `messages-media.js` throws `new Boom('content length exceeded when
 *     encrypting "...")` with NO explicit `statusCode` (so Boom's own
 *     default of 500 applies) when a caller-supplied `maxContentLength` is
 *     exceeded - statusCode 500 alone is indistinguishable from a generic
 *     server error, so this table also matches on the literal message
 *     substring for this one row (`content length exceeded`), verified
 *     against the pinned source line, not invented.
 *   - `messages-media.js` also throws `new Boom('No valid media URL or
 *     directPath present in message', {statusCode: 400})` - mapped to
 *     `invalid_payload` (malformed message content, not a bad recipient).
 *
 * NOT confirmed live in this pinned version, therefore intentionally absent
 * from the table (falls through to `'unknown'`, per the fail-safe rule
 * above rather than being guessed at):
 *   - A dedicated "invalid/malformed JID" Boom in the send path (Baileys'
 *     `jidNormalizedUser` et al. do not throw a Boom in 7.0.0-rc14's send
 *     path for a malformed JID that this table could find).
 *   - A 429/rate-limit Boom from WhatsApp itself surfaced through the send
 *     path (no `429` statusCode literal appears anywhere under
 *     `lib/Socket`/`lib/Utils` in the pinned tree). 429 is still mapped
 *     below (harmless if never hit today, and HTTP 429 is the correct
 *     signal per the phase spec if a future Baileys version - or a Cloud
 *     API adapter reusing this same shape - does surface one), with
 *     `retryAfterMs` extracted from `output.headers['retry-after']` when
 *     present, per the phase spec.
 *   - A 401/403/"forbidden"/ban/spam Boom specific to a SEND (as opposed to
 *     the connection-level 401/403 already owned by `disconnect-map.ts`,
 *     which governs the SOCKET, not an individual send). This table still
 *     maps 401/403 defensively (a provider-boundary rejection carrying one
 *     of those codes is a restriction signal by definition, wherever it
 *     originates), but no live pinned-source call site throws one from the
 *     send functions themselves.
 */

export interface BoomLikeError {
  readonly message?: string;
  readonly output?: {
    readonly statusCode?: number;
    readonly headers?: Readonly<Record<string, string | string[] | number | undefined>>;
  };
  readonly data?: unknown;
}

/**
 * P16 Unit C - @g.us authorisation carve-out (scope delta § Groups). A
 * `restricted`-shaped (401/403) rejection whose message names one of these
 * group-authorisation reasons, targeting a `@g.us` recipient, is terminal
 * for that ONE job (`group_forbidden`) and contributes NOTHING to the
 * instance-level hard-restriction health signal - unlike every other
 * `restricted` rejection. No live pinned-source Boom shape for this is
 * confirmed (same "not confirmed live" caveat as this file's own module
 * doc for a dedicated invalid-JID Boom) - message-substring matched, same
 * idiom as `MESSAGE_SUBSTRING_MAP` above, kept honest rather than guessed
 * at a statusCode.
 */
const GROUP_AUTHORISATION_REASON_SUBSTRINGS = Object.freeze([
  'not-admin',
  'announce-mode',
  'not-participant',
]);

function isGroupJid(recipientJid: string | undefined): boolean {
  return recipientJid !== undefined && recipientJid.endsWith('@g.us');
}

function isGroupAuthorisationRejection(message: string): boolean {
  return GROUP_AUTHORISATION_REASON_SUBSTRINGS.some((substring) => message.includes(substring));
}

export interface ClassifySendErrorOptions {
  /** The message's target JID, when known - only the caller (`adapter.ts`'s `send()`) has this; the raw provider error itself never carries it. */
  readonly recipientJid?: string;
}

const STATUS_CODE_MAP: Readonly<Record<number, SendErrorClass>> = Object.freeze({
  400: 'invalid_payload',
  401: 'restricted',
  403: 'restricted',
  408: 'not_connected',
  428: 'not_connected',
  429: 'rate_limited',
  500: 'transient',
  502: 'transient',
  503: 'transient',
  504: 'transient',
});

/** Message-substring fallbacks for Boom errors that carry no distinguishing statusCode (see module doc comment). */
const MESSAGE_SUBSTRING_MAP: ReadonlyArray<{ substring: string; sendErrorClass: SendErrorClass }> =
  Object.freeze([{ substring: 'content length exceeded', sendErrorClass: 'invalid_payload' }]);

function isBoomLike(err: unknown): err is BoomLikeError {
  return typeof err === 'object' && err !== null;
}

function extractRetryAfterMs(err: BoomLikeError): number | undefined {
  const headerValue = err.output?.headers?.['retry-after'];
  if (headerValue === undefined) {
    return undefined;
  }
  const seconds = typeof headerValue === 'number' ? headerValue : Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * Pure lookup. Fail-safe default: any error this table does not recognise
 * (missing statusCode, unmapped statusCode, no matching message substring)
 * maps to `'unknown'` - NEVER `'transient'`, per core invariant 2.
 */
export function classifySendError(
  err: unknown,
  options: ClassifySendErrorOptions = {},
): {
  sendErrorClass: SendErrorClass;
  retryAfterMs?: number;
} {
  if (!isBoomLike(err)) {
    return { sendErrorClass: 'unknown' };
  }

  const statusCode = err.output?.statusCode;
  if (statusCode !== undefined && Object.hasOwn(STATUS_CODE_MAP, statusCode)) {
    const sendErrorClass = STATUS_CODE_MAP[statusCode] as SendErrorClass;
    if (
      sendErrorClass === 'restricted' &&
      isGroupJid(options.recipientJid) &&
      isGroupAuthorisationRejection(err.message ?? '')
    ) {
      return { sendErrorClass: 'group_forbidden' };
    }
    const retryAfterMs = sendErrorClass === 'rate_limited' ? extractRetryAfterMs(err) : undefined;
    return retryAfterMs !== undefined ? { sendErrorClass, retryAfterMs } : { sendErrorClass };
  }

  const message = err.message ?? '';
  for (const row of MESSAGE_SUBSTRING_MAP) {
    if (message.includes(row.substring)) {
      return { sendErrorClass: row.sendErrorClass };
    }
  }

  return { sendErrorClass: 'unknown' };
}
