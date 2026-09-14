/**
 * The typed structured-log field allow-list (data-security design §6.5).
 * `LogFields` is the compile-time half of the contract; `logger.ts` never
 * accepts a bare `Record<string, unknown>` for a log call, only this type.
 *
 * All fields are optional because a single call site rarely has all of
 * them, and every value is `string | number` - nothing here is ever a
 * nested object, so there is no sub-key to accidentally leak through.
 */
export type LogFields = {
  request_id?: string;
  client_id?: string;
  instance_id?: string;
  job_public_id?: string;
  attempt_no?: number;
  lease_id?: string;
  event_type?: string;
  error_class?: string;
  status_code?: number;
  duration_ms?: number;
  actor_type?: string;
  actor_id?: string;
  route?: string;
  worker_id?: string;
  kek_id?: string;
  error_summary?: string;
};

/**
 * The runtime half of the allow-list: `logger.ts`'s serializer filters every
 * log call's fields against this `Set` before the line ever reaches pino.
 *
 * This exists separately from `LogFields` because TypeScript types are
 * erased at runtime - a caller that casts an object through `unknown` (or
 * plain `any`) can hand the logger extra keys the type checker never saw,
 * so the allow-list must also be enforced with a runtime value. Logging
 * here is allow-list, not blocklist: any key not in this `Set` is dropped,
 * never logged, regardless of what the caller passes.
 */
export const ALLOWED_LOG_FIELDS: ReadonlySet<keyof LogFields> = new Set([
  'request_id',
  'client_id',
  'instance_id',
  'job_public_id',
  'attempt_no',
  'lease_id',
  'event_type',
  'error_class',
  'status_code',
  'duration_ms',
  'actor_type',
  'actor_id',
  'route',
  'worker_id',
  'kek_id',
  'error_summary',
]);
