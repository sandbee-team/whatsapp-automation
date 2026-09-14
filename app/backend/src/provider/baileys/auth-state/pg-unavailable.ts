/**
 * pg-unavailable.ts (P26 U6a) - `isPgUnavailableError`: the ONE classifier
 * `creds-save-buffer.ts` uses to distinguish "Postgres itself is
 * unreachable/refusing connections" from every other `saveCreds` failure
 * (fence/epoch conflict, `CredsSaveExhaustedError`, decrypt/codec errors,
 * constraint violations). This is deliberately narrow and closed-set: a
 * miss here (an availability error not recognised) fails CLOSED - the
 * caller treats it as an ordinary error and rethrows/self-fences exactly
 * like today, never as a silent buffer-and-swallow. Mirrors the
 * classification discipline `heartbeat.ts`'s PG-renew-failure branch
 * already uses (an explicit non-trigger, never inferred from a generic
 * catch), without duplicating its logic - this is a pure predicate with no
 * side effects.
 */

/** Postgres SQLSTATE codes that mean "the server/connection is unavailable", never a query-semantic failure. */
const PG_UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '53300', // too_many_connections
]);

/** Node-level connection error codes surfaced by the `pg` driver's own socket layer. */
const NODE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const UNAVAILABLE_MESSAGE_PATTERN =
  /connection terminated|terminating connection|timeout exceeded when trying to connect|Connection terminated unexpectedly|the database system is (?:shutting down|starting up)/i;

/**
 * True ONLY for an error shape that means "Postgres/the connection is
 * unavailable" - a SQLSTATE in `PG_UNAVAILABLE_SQLSTATES`, a Node socket code
 * in `NODE_UNAVAILABLE_CODES`, or a message matching
 * `UNAVAILABLE_MESSAGE_PATTERN`. Everything else (incl. `FenceConflictError`,
 * `CredsSaveExhaustedError`, `23505`, `42P01`, and any error with no
 * recognisable code/message at all) is false - fail-safe means failing
 * CLOSED on an unrecognised shape, never guessing "probably an outage".
 */
export function isPgUnavailableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (PG_UNAVAILABLE_SQLSTATES.has(code) || NODE_UNAVAILABLE_CODES.has(code)) {
      return true;
    }
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && UNAVAILABLE_MESSAGE_PATTERN.test(message)) {
    return true;
  }
  return false;
}
