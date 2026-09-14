/**
 * broadcasts.errors.ts (P23 Unit U5, step 6) - the typed error classes
 * `lifecycle.service.ts`/`broadcasts.routes.ts` throw, mapped by
 * `platform/http/error-mapper.ts#sendError` via each class's `.code`
 * (canon: every response error goes through that one mapper, never a
 * hand-rolled shape here).
 */

export class BroadcastNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such broadcast.');
    this.name = 'BroadcastNotFoundError';
  }
}

export class InstanceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such instance.');
    this.name = 'InstanceNotFoundError';
  }
}

/**
 * A human owns a broadcast's lifecycle (create/start/pause/resume/cancel) -
 * `assertUserActor` throws this BEFORE any query runs whenever `actor.kind`
 * is not `'user'`, or is `'user'` with a missing/blank `userId` - the same
 * fail-closed shape `modules/queue/unresolved.service.ts#assertUserActor`
 * uses (no second, independently-drifting actor gate).
 */
export class BroadcastActorForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(kind: string) {
    super(
      kind === 'user'
        ? 'A user actor with a userId is required for this action.'
        : `Actor kind "${kind}" may not manage a broadcast's lifecycle - a human user action is required.`,
    );
    this.name = 'BroadcastActorForbiddenError';
  }
}

/**
 * A `transition()` conditional UPDATE matched zero rows - someone else
 * already moved the campaign out of the expected `from` state(s) first.
 * Never a blind retry (core invariant 3): the caller surfaces this as a
 * conflict.
 */
export class IllegalBroadcastTransitionError extends Error {
  readonly code = 'CONFLICT';
  constructor(id: string) {
    super(`broadcast ${id} is not in a state that allows this action.`);
    this.name = 'IllegalBroadcastTransitionError';
  }
}

export class IdempotencyKeyRequiredError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  constructor() {
    super('An Idempotency-Key header is required for this action.');
    this.name = 'IdempotencyKeyRequiredError';
  }
}

/** A pre-flight quote was requested for a campaign already past `draft`/`scheduled` - the same "someone already moved it" 409 shape as `IllegalBroadcastTransitionError`. */
export class PreflightNotAllowedError extends Error {
  readonly code = 'CONFLICT';
  constructor(id: string) {
    super(`broadcast ${id} is not in a state that allows a pre-flight quote.`);
    this.name = 'PreflightNotAllowedError';
  }
}

/**
 * P23a C1 fix round unit F2 (MINOR 4) - the client has NO plan attached at
 * all (`resolveEffectiveMaxBroadcastRecipients` returned `null`), a distinct
 * failure kind from `PreflightAudienceOverLimitError` (a plan IS attached
 * but the audience exceeds its ceiling). Conflating the two previously
 * rendered "exceeds the plan's broadcast recipient limit (0)" for a client
 * that has no plan at all - a dishonest "limit is zero" message. Mapped
 * `ENTITLEMENT_ERROR` (402) - an unused-until-now code that is the honest
 * fit ("this client is not entitled to size a broadcast without a plan"),
 * never bare `CONTACT_LIMIT_REACHED` (that code's own contract is "a plan IS
 * attached and its numeric ceiling was reached").
 */
export class PreflightNoPlanError extends Error {
  readonly code = 'ENTITLEMENT_ERROR';
  constructor() {
    super('This client has no plan attached; a broadcast cannot be quoted.');
    this.name = 'PreflightNoPlanError';
  }
}

/** The audience the pre-flight would quote exceeds the plan's `max_broadcast_recipients` ceiling - carries `count`/`limit` so a client can render an upgrade prompt, mapped 409 like `CONTACT_LIMIT_REACHED`. */
export class PreflightAudienceOverLimitError extends Error {
  readonly code = 'CONTACT_LIMIT_REACHED';
  readonly details: { count: number; limit: number };
  constructor(count: number, limit: number) {
    super(
      `Audience (${String(count)}) exceeds the plan's broadcast recipient limit (${String(limit)}).`,
    );
    this.name = 'PreflightAudienceOverLimitError';
    this.details = { count, limit };
  }
}

/**
 * P24 groups-messaging Unit U6: a `groups`-audience broadcast's message body
 * carries a `{{token}}` - rejected at CREATE time, mapped to the generic
 * `VALIDATION_ERROR` (400, deviation noted in the unit's own report: no new
 * `@wp/contracts` error code was added in this unit's scope). Groups never
 * resolve a template (no per-recipient contact record to resolve against),
 * so a variable body is caught here rather than silently freezing every
 * recipient's `vars` to `{}` and rendering the literal `{{token}}` text.
 */
export class GroupsAudienceTemplateVarsError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('A groups broadcast message may not contain template variables.');
    this.name = 'GroupsAudienceTemplateVarsError';
  }
}
