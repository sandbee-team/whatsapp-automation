/**
 * groups.errors.ts (P24 Unit U3, step 4/5) - the typed error classes
 * `groups.service.ts`/`groups.routes.ts` throw, mapped by
 * `platform/http/error-mapper.ts#sendError` via each class's `.code`
 * (canon: every response error goes through that one mapper, never a
 * hand-rolled shape here - same discipline as `broadcasts.errors.ts`).
 */

/** A foreign or missing instance/group id - ALWAYS 404, never 403 (RLS + explicit client_id-scoped query, same idiom as `contacts/routes.ts`). */
export class GroupInstanceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such instance.');
    this.name = 'GroupInstanceNotFoundError';
  }
}

/** A foreign or missing group id, or a group that has already left (`left_at IS NOT NULL`) - ALWAYS 404. */
export class GroupNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such group.');
    this.name = 'GroupNotFoundError';
  }
}

export class IdempotencyKeyRequiredError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  constructor() {
    super('An Idempotency-Key header is required for this action.');
    this.name = 'IdempotencyKeyRequiredError';
  }
}

/**
 * `POST /v1/instances/:id/groups/sync` refused a request inside
 * `GROUP_SYNC_MIN_INTERVAL_MS` of the instance's last sync - mapped 429 with
 * a `Retry-After` header (`groups.routes.ts` sets it directly from
 * `retryAfterSeconds`, since `RateLimitedError`'s own `RateLimitResult` shape
 * is a Redis-bucket concept that does not fit this DB-clock-gated refusal).
 */
export class GroupSyncRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('A group sync was already requested recently for this instance.');
    this.name = 'GroupSyncRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * `PATCH /v1/groups/:id/send-enabled` refused an enable because
 * `canEnableGroupSend` returned `ANNOUNCE_MEMBER_ONLY`/`DEVICE_BUDGET_EXCEEDED`
 * - `details` names the reason plus (for `DEVICE_BUDGET_EXCEEDED`) the
 * current total, this group's devices and the max, per
 * `groupNotSendableDetailsSchema`.
 */
export class GroupNotSendableError extends Error {
  readonly code = 'GROUP_NOT_SENDABLE';
  readonly details: {
    reason: 'ANNOUNCE_MEMBER_ONLY' | 'DEVICE_BUDGET_EXCEEDED';
    trackedDevicesEnabledTotal?: number;
    groupTrackedDevices?: number;
    max?: number;
  };
  constructor(details: GroupNotSendableError['details']) {
    super(`group is not sendable: ${details.reason}`);
    this.name = 'GroupNotSendableError';
    this.details = details;
  }
}
