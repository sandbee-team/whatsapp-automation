/**
 * routes/internal-errors.ts (P28 Unit U3b, step 5) - the typed errors the
 * U3b mutation routes raise, shared by `clients.ts`/`clients-limits.ts`/
 * `instances.ts`/`pacing.ts`/`campaigns.ts` so all five map through
 * `error-mapper.ts`'s single envelope with the SAME code per situation (a
 * per-file copy would let one route answer 409 where its sibling answers
 * 422 for the identical condition).
 *
 * Each `code` is an existing `@wp/contracts` `ErrorCode` - never a new one:
 * `INVALID_STATE` -> 409 (the target row is in a state staff may not move
 * from), `NOT_FOUND` -> 404 (the row does not exist, or belongs to another
 * tenant - deliberately indistinguishable, so a staff caller cannot probe
 * which ids exist under which client).
 */

export class InternalInvalidStateError extends Error {
  readonly code = 'INVALID_STATE';
  constructor(message: string) {
    super(message);
    this.name = 'InternalInvalidStateError';
  }
}

export class InternalTargetNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message = 'No such record for this client.') {
    super(message);
    this.name = 'InternalTargetNotFoundError';
  }
}

/**
 * 422 - a `provider_restriction` pause may only be resumed by a human who
 * has explicitly acknowledged the restriction. Deliberately the SAME code
 * (`ACKNOWLEDGEMENT_REQUIRED`) the tenant's own resume route raises via
 * `modules/instances/resume-support.ts`: staff get no shortcut past a
 * restriction pause that a tenant would not get (safety-compliance -
 * "recover only through the provider's legitimate path"). A local class
 * rather than an import of that one because `no-deep-module-import` forbids
 * `modules/internal` reaching past `modules/instances`' public surface,
 * which does not export it.
 */
export class InternalAcknowledgementRequiredError extends Error {
  readonly code = 'ACKNOWLEDGEMENT_REQUIRED';
  constructor() {
    super(
      'This instance was paused by a provider restriction. Resuming requires an explicit acknowledgement.',
    );
    this.name = 'InternalAcknowledgementRequiredError';
  }
}
