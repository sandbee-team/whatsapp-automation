import { createLogger, type WpLogger } from '@wp/server-kit';

/**
 * platform/logger.ts (P28 Unit U4, step 6) - admin-backend's logger, built
 * on `@wp/server-kit`'s `createLogger` so it inherits the shared field
 * ALLOW-LIST serializer.
 *
 * That allow-list is why this is a thin wrapper rather than a direct pino
 * call: any field name not on `ALLOWED_LOG_FIELDS` is DROPPED, `recipient`/
 * `body`/`payload`/`token`/`qr` are hard-redacted unconditionally, and a
 * whole error object is reduced to a name+code summary. So an admin log
 * line cannot carry a phone number, a message body, or a raw pg error's
 * offending row values even if a future caller passes one - which on a
 * surface that reads across every tenant is exactly the guarantee worth
 * having mechanically rather than by convention.
 *
 * `createLogger()` takes an optional destination stream (level comes from
 * `@wp/server-kit`'s own `WP_LOG_LEVEL` config), so this exists mainly to
 * give admin-backend ONE import site to change if that ever needs a
 * per-process destination.
 */
export function createAdminLogger(destination?: NodeJS.WritableStream): WpLogger {
  return createLogger(destination);
}
