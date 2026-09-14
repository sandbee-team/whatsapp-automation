import pino, { type Logger as PinoLogger } from 'pino';
import { config } from '../config/index.js';
import { describeError } from './describe-error.js';
import { ALLOWED_LOG_FIELDS, type LogFields } from './log-fields.js';

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type PinoLevel = (typeof PINO_LEVELS)[number];

/**
 * Fields that are hard-redacted regardless of the allow-list (data-security
 * design §6.5). These are dropped even if a future change widens
 * `ALLOWED_LOG_FIELDS` to reuse one of these names for something else - the
 * check below runs unconditionally, before the allow-list check, so a wider
 * allow-list can never resurrect one of these keys by accident.
 */
const HARD_REDACTED_KEYS: ReadonlySet<string> = new Set([
  'recipient',
  'body',
  'payload',
  'creds',
  'token',
  'authorization',
  'qr',
]);

/**
 * Filters an arbitrary log-call payload down to allow-listed keys only,
 * dropping everything else. This runs on every call regardless of what
 * static type the caller's object claims to have - `LogFields` at the
 * call-site type checker is not the enforcement mechanism, this function is
 * (a caller can always cast through `unknown`/`any` to bypass the type).
 */
function sanitizeFields(fields: LogFields): Record<string, unknown> {
  const raw = fields as unknown as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (HARD_REDACTED_KEYS.has(key)) {
      continue;
    }
    // Defense in depth: a caller that hands an `err`/`error` object straight
    // to the logger (bypassing `describeError` at the call site) still never
    // leaks `message`/`detail`/`where` - it is reduced to a name+code summary.
    if ((key === 'err' || key === 'error') && typeof raw[key] === 'object' && raw[key] !== null) {
      safe.error_summary = describeError(raw[key]);
      continue;
    }
    if (!ALLOWED_LOG_FIELDS.has(key as keyof LogFields)) {
      continue;
    }
    // Value-type filter: `LogFields`' own type says every field is
    // `string | number`, but that is compile-time only - a caller that casts
    // through `unknown` can put an object (e.g. a `body`-shaped one) behind
    // an allow-listed key name and smuggle its nested keys through verbatim.
    // Only copy primitive values; drop anything else regardless of key name.
    const value = raw[key];
    if (typeof value === 'string' || typeof value === 'number') {
      safe[key] = value;
    }
  }
  return safe;
}

type LogMethod = (fields: LogFields, msg: string) => void;

/**
 * The public logger surface. Deliberately narrow: one method per pino level,
 * each taking `(fields: LogFields, msg: string)`. There is no `.child()` -
 * see the module doc comment on `createLogger` for why.
 */
export type WpLogger = Readonly<Record<PinoLevel, LogMethod>>;

function wrap(pinoLogger: PinoLogger): WpLogger {
  const methodFor = (level: PinoLevel): LogMethod => {
    return (fields, msg) => {
      pinoLogger[level](sanitizeFields(fields), msg);
    };
  };
  const entries = PINO_LEVELS.map((level) => [level, methodFor(level)] as const);
  return Object.fromEntries(entries) as WpLogger;
}

/**
 * Builds a `WpLogger`. `destination` is only ever supplied by tests, to
 * inject a synchronous capture stream in place of stdout - production call
 * sites use the shared `logger` export below instead of calling this
 * directly.
 *
 * NO per-session bindings: this deliberately does not expose pino's
 * `.child()` anywhere. At the 10k-session structural target (ADR 0018), a
 * child logger bound per instance/session is real, avoidable memory - every
 * call site instead passes its own identifying fields (`instance_id`,
 * `job_public_id`, ...) through `LogFields` on each call.
 */
export function createLogger(destination?: NodeJS.WritableStream): WpLogger {
  const pinoLogger = destination
    ? pino({ level: config.WP_LOG_LEVEL }, destination)
    : pino({ level: config.WP_LOG_LEVEL });
  return wrap(pinoLogger);
}

/**
 * The one shared pino instance for this process (`level` from `config`, per
 * step 4's design - see `plan/v1/P01-server-kit-and-crypto.md`). Every
 * module in the workspace logs through this instance rather than creating
 * its own.
 */
export const logger: WpLogger = createLogger();
